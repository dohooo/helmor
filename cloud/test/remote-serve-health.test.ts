import type { Sandbox } from "@cloudflare/sandbox";
import { describe, expect, it } from "vitest";
import { type Env, ensureServe, healthOk } from "../src/index";

describe("remote sandbox serve health", () => {
	it("treats a hung health check as unhealthy", async () => {
		const sandbox = {
			containerFetch: () => new Promise<Response>(() => {}),
		} as unknown as Sandbox;

		await expect(healthOk(sandbox, 8080, 5)).resolves.toBe(false);
	});

	it("routes companion health through the internal DO fetch proxy", async () => {
		const paths: string[] = [];
		const sandbox = {
			fetch: async (request: Request) => {
				paths.push(new URL(request.url).pathname);
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		} as unknown as Sandbox;

		await expect(healthOk(sandbox, 8080, 50)).resolves.toBe(true);
		expect(paths).toEqual(["/__helmor-companion/8080/v1/health"]);
	});

	it("does not let an initial hung containerFetch prevent startProcess", async () => {
		let fetchCalls = 0;
		let startCalls = 0;
		const sandbox = {
			containerFetch: () => {
				fetchCalls += 1;
				if (fetchCalls === 1) return new Promise<Response>(() => {});
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			startProcess: async (
				_command: string,
				options: { env?: Record<string, string> },
			) => {
				startCalls += 1;
				expect(options.env?.HELMOR_COMPANION_TOKEN).toBe("companion-token");
				expect(options.env?.HELMOR_SERVE_PORT).toBe("8080");
			},
		} as unknown as Sandbox;

		await ensureServe(sandbox, makeEnv(), 8080, {
			healthCheckTimeoutMs: 5,
			restoreBackupTimeoutMs: 5,
			startProcessTimeoutMs: 20,
			identityMintTimeoutMs: 20,
			readyTimeoutMs: 50,
			pollIntervalMs: 1,
		});

		expect(startCalls).toBe(1);
		expect(fetchCalls).toBeGreaterThanOrEqual(2);
	});

	it("fast-fails a PERMANENT container-start error before restore/mint/startProcess", async () => {
		let startCalls = 0;
		const sandbox = {
			// The Sandbox SDK RETURNS (never throws) a 500 with context.phase
			// "startup" for a permanent start failure.
			containerFetch: async () =>
				new Response(
					JSON.stringify({
						code: "INTERNAL_ERROR",
						message:
							"Container failed to start due to a permanent error. Check your container configuration.",
						context: { phase: "startup", error: "image pull failed" },
					}),
					{ status: 500, headers: { "content-type": "application/json" } },
				),
			startProcess: async () => {
				startCalls += 1;
			},
		} as unknown as Sandbox;

		await expect(
			ensureServe(sandbox, makeEnv(), 8080, {
				healthCheckTimeoutMs: 50,
				restoreBackupTimeoutMs: 5,
				startProcessTimeoutMs: 20,
				identityMintTimeoutMs: 20,
				readyTimeoutMs: 50,
				pollIntervalMs: 1,
			}),
		).rejects.toThrow(/permanent error/i);
		// Fast-fail: we never burn the ~15s restore/mint + startProcess on a
		// backend the platform already marked unrecoverable.
		expect(startCalls).toBe(0);
	});

	it("does NOT treat a transient 503 as permanent (keeps cold-starting)", async () => {
		let startCalls = 0;
		let fetchCalls = 0;
		const sandbox = {
			containerFetch: async () => {
				fetchCalls += 1;
				// First probe: transient "provisioning" 503 → keep going. Later: healthy.
				if (fetchCalls === 1) {
					return new Response(
						JSON.stringify({
							message: "Container is currently provisioning.",
							context: { phase: "provisioning" },
						}),
						{ status: 503, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			startProcess: async () => {
				startCalls += 1;
			},
		} as unknown as Sandbox;

		await ensureServe(sandbox, makeEnv(), 8080, {
			healthCheckTimeoutMs: 50,
			restoreBackupTimeoutMs: 5,
			startProcessTimeoutMs: 20,
			identityMintTimeoutMs: 20,
			readyTimeoutMs: 50,
			pollIntervalMs: 1,
		});
		expect(startCalls).toBe(1);
	});
});

function makeEnv(): Env {
	return {
		DB: {
			prepare: () => ({
				bind: () => ({
					first: async () => null,
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

function identityNamespace() {
	return {
		idFromName: (name: string) => name,
		get: () => ({}),
	} as unknown as Env["CODEX_IDENTITY"];
}
