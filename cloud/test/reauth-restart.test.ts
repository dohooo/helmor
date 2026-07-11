/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Round6 P1-4a (sub-problem ②): a cloud-identity (re-)authorization must
// trigger a REAL restart — backup-then-DESTROY — never the old `stop()`
// (SIGTERM), which `helmor serve` ignores (the VM stayed active:1 caching the
// old credential, live-verified on the idle path in index.ts).
//
// Pins, in order of blast radius:
//   (1) `Sandbox.backupThenDestroyForReauth` backs up BEFORE destroying —
//       the architect-mandated hard rule (a bare destroy rolls /home/helmor
//       back to the last idle snapshot);
//   (2) `restartSandboxForReauth` guard semantics: serving → restart; not
//       serving → NO touch (scaled-to-zero has no real disk to snapshot);
//       best-effort (never throws);
//   (3) the WIRING: the real putCodexIdentity / putClaudeIdentity (via the
//       gateway store) fire the restart hook exactly when `changed` is true.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { Sandbox } from "../src/index";
import {
	createWorkerTeamGatewayStore,
	restartSandboxForReauth,
	type TeamGatewayStoreDeps,
} from "../src/team";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
	}
}

const CREATE_TEAMS = `CREATE TABLE IF NOT EXISTS teams (
  id                       TEXT PRIMARY KEY,
  sandbox_id               TEXT NOT NULL,
  backup_handle            TEXT,
  cloud_identity_member_id TEXT,
  forge_identity_member_id TEXT
)`;

type TestEnv = import("../src/index").Env;

beforeEach(async () => {
	await env.DB.exec(CREATE_TEAMS.replace(/\n\s*/g, " "));
	await env.DB.exec("DELETE FROM teams");
});

describe("Sandbox.backupThenDestroyForReauth (P1-4a hard rule)", () => {
	it("backs up BEFORE destroying — never a bare destroy", async () => {
		const calls: string[] = [];
		const fake = {
			backupBeforeSleep: async () => {
				calls.push("backup");
			},
			destroy: async () => {
				calls.push("destroy");
			},
		};
		await Sandbox.prototype.backupThenDestroyForReauth.call(fake);
		expect(calls).toEqual(["backup", "destroy"]);
	});
});

describe("restartSandboxForReauth (guard semantics)", () => {
	it("SERVING → backup-then-destroy over the stub", async () => {
		let restarts = 0;
		await restartSandboxForReauth(
			{
				backupThenDestroyForReauth: async () => {
					restarts += 1;
				},
			},
			async () => true,
		);
		expect(restarts).toBe(1);
	});

	it("NOT serving → no container touch at all", async () => {
		let restarts = 0;
		await restartSandboxForReauth(
			{
				backupThenDestroyForReauth: async () => {
					restarts += 1;
				},
			},
			async () => false,
		);
		expect(restarts).toBe(0);
	});

	it("is best-effort: a throwing probe or restart never rejects", async () => {
		await expect(
			restartSandboxForReauth(
				{
					backupThenDestroyForReauth: async () => {},
				},
				() => Promise.reject(new Error("probe boom")),
			),
		).resolves.toBeUndefined();
		await expect(
			restartSandboxForReauth(
				{
					backupThenDestroyForReauth: () =>
						Promise.reject(new Error("restart boom")),
				},
				async () => true,
			),
		).resolves.toBeUndefined();
	});
});

describe("cloud-identity PUT wiring (P1-4a)", () => {
	function storeWithSpy(): {
		store: ReturnType<typeof createWorkerTeamGatewayStore>;
		counts: { restarts: number; reinjects: number };
	} {
		const counts = { restarts: 0, reinjects: 0 };
		const deps: TeamGatewayStoreDeps = {
			reinjectForgeCreds: async () => {
				counts.reinjects += 1;
			},
			restartForReauth: async () => {
				counts.restarts += 1;
			},
		};
		return {
			store: createWorkerTeamGatewayStore(
				env as unknown as TestEnv,
				new URL("https://team.test/"),
				deps,
			),
			counts,
		};
	}

	// `changed` in the identity DOs means "a token was ALREADY stored" (this
	// PUT is a RE-authorization) — see ClaudeIdentity.store. The FIRST
	// authorization must not restart (nothing minted the credential yet; the
	// next cold start injects it), a RE-authorization must (the running serve
	// holds the OLD credential as startProcess env).
	it("putClaudeIdentity does NOT restart on the FIRST authorization", async () => {
		const { store, counts } = storeWithSpy();
		await store.putClaudeIdentity("100", {
			oauthToken: "sk-ant-oat01-first-auth",
		});
		expect(counts.restarts).toBe(0);
	});

	it("putClaudeIdentity fires the restart hook on a RE-authorization", async () => {
		// Distinct member id: DO storage persists across tests in this isolate,
		// and member "100" already authorized in the test above.
		const { store, counts } = storeWithSpy();
		await store.putClaudeIdentity("101", {
			oauthToken: "sk-ant-oat01-first-auth",
		});
		await store.putClaudeIdentity("101", {
			oauthToken: "sk-ant-oat01-re-auth",
		});
		expect(counts.restarts).toBe(1);
		// And never the forge re-inject — that hook belongs to the forge PUT.
		expect(counts.reinjects).toBe(0);
	});
});
