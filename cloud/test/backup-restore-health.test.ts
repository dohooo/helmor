import type { Sandbox } from "@cloudflare/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
	BACKUP_EXCLUDES,
	BACKUP_SIZE_WARN_BYTES,
	ContainerRestoreError,
	type Env,
	ensureServe,
	warnIfBackupOversized,
} from "../src/index";

function identityNamespace() {
	return {
		idFromName: (name: string) => name,
		get: () => ({}),
	} as unknown as Env["CODEX_IDENTITY"];
}

function makeEnv(backupHandle: string | null): Env {
	return {
		DB: {
			prepare: () => ({
				bind: () => ({
					first: async () =>
						backupHandle ? { backup_handle: backupHandle } : null,
				}),
			}),
		},
		HELMOR_SANDBOX_ID: "sandbox-test",
		HELMOR_COMPANION_PORT: "8080",
		HELMOR_COMPANION_TOKEN: "companion-token",
		CODEX_IDENTITY: identityNamespace(),
		CLAUDE_IDENTITY: identityNamespace(),
		BROKER_ENC_KEY: "test",
		Sandbox: {} as Env["Sandbox"],
	} as unknown as Env;
}

const HANDLE = JSON.stringify({
	id: "backup-1",
	dir: "/home/helmor",
	localBucket: true,
});

describe("R3-D backup/restore health", () => {
	// The P0 (OBS-R3C-3): a restore that fails (isolate OOM reset, timeout,
	// corrupt archive) used to log "cold-starting empty" and press on against
	// a dead DO — every wake 503'd in a silent loop. It must now be LOUD.
	it("a failing restoreBackup rejects ensureServe with the typed ContainerRestoreError", async () => {
		const sandbox = {
			// Initial probe: not healthy → cold-start path.
			containerFetch: async () =>
				new Response(JSON.stringify({}), { status: 503 }),
			restoreBackup: async () => {
				throw new Error(
					"Durable Object's isolate exceeded its memory limit and was reset.",
				);
			},
			startProcess: async () => {
				throw new Error("startProcess must not be reached");
			},
		} as unknown as Sandbox;

		await expect(
			ensureServe(sandbox, makeEnv(HANDLE), 8080, {
				healthCheckTimeoutMs: 5,
				restoreBackupTimeoutMs: 50,
				startProcessTimeoutMs: 20,
				identityMintTimeoutMs: 5,
				readyTimeoutMs: 30,
				pollIntervalMs: 5,
			}),
		).rejects.toBeInstanceOf(ContainerRestoreError);
	});

	it("a MISSING backup handle still cold-starts empty (no restore, no error)", async () => {
		let restoreCalls = 0;
		let startCalls = 0;
		const sandbox = {
			containerFetch: async () => {
				if (startCalls > 0) {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(JSON.stringify({}), { status: 503 });
			},
			restoreBackup: async () => {
				restoreCalls += 1;
			},
			startProcess: async () => {
				startCalls += 1;
			},
		} as unknown as Sandbox;

		const result = await ensureServe(sandbox, makeEnv(null), 8080, {
			healthCheckTimeoutMs: 5,
			restoreBackupTimeoutMs: 50,
			startProcessTimeoutMs: 20,
			identityMintTimeoutMs: 5,
			readyTimeoutMs: 200,
			pollIntervalMs: 5,
		});
		expect(result.coldStarted).toBe(true);
		expect(restoreCalls).toBe(0);
		expect(startCalls).toBe(1);
	});

	// The excludes list is the P0's actual fix: `.codex/.tmp` (the Codex
	// plugin-marketplace cache) inflated the archive 700x and OOM'd restore.
	it("backup excludes cover the regenerable provider cache", () => {
		expect(BACKUP_EXCLUDES).toContain(".codex/.tmp");
		// Pre-existing disposable trees stay excluded.
		for (const dir of ["workspaces", "cache", "logs", "run", "local-llm"]) {
			expect(BACKUP_EXCLUDES).toContain(dir);
		}
	});

	it("warns when a backup exceeds the size budget — and stays quiet under it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handle = { id: "b1", dir: "/home/helmor", localBucket: true };
		const envWith = (size: number) =>
			({
				BACKUP_BUCKET: { head: async () => ({ size }) },
			}) as unknown as Env;

		await warnIfBackupOversized(envWith(BACKUP_SIZE_WARN_BYTES + 1), handle);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("size budget exceeded");

		warn.mockClear();
		await warnIfBackupOversized(envWith(4 * 1024 * 1024), handle);
		expect(warn).not.toHaveBeenCalled();

		// Best-effort: a head() failure never throws.
		await warnIfBackupOversized(
			{
				BACKUP_BUCKET: {
					head: async () => {
						throw new Error("r2 down");
					},
				},
			} as unknown as Env,
			handle,
		);
		warn.mockRestore();
	});
});
