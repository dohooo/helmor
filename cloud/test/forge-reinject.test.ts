/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Round6 P1-4a (sub-problem ①): forge (re-)authorize must re-inject the
// members file into a RUNNING container, live.
//
// Before the fix, `injectForgeMembers` ran ONLY at cold start (`ensureServe`),
// so `PUT /team/forge-identity` left a warm container's creds stale until a
// manual destroy — live-reproduced in the class2 rollout as a private-repo
// clone failing with `could not read Username`. These tests pin:
//   (1) the guard semantics of `reinjectForgeMembersIfServing`: serving →
//       write the collected creds to FORGE_MEMBERS_PATH; not serving → NO
//       container touch at all (a write would spin up a serve-less VM);
//       best-effort (a probe/write failure never throws);
//   (2) the WIRING: the real `putForgeIdentity` (via the gateway store) fires
//       the re-inject hook — the exact call that was missing.
//
// Runs inside workerd with the real ForgeIdentity DO and a real in-memory D1.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	FORGE_MEMBERS_PATH,
	type ForgeInjectableSandbox,
	reinjectForgeMembersIfServing,
} from "../src/forge-creds";
import {
	createWorkerTeamGatewayStore,
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
const CREATE_MEMBERS = `CREATE TABLE IF NOT EXISTS members (
  id           TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  avatar_url   TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL
)`;

type TestEnv = import("../src/index").Env;

beforeEach(async () => {
	await env.DB.exec(CREATE_TEAMS.replace(/\n\s*/g, " "));
	await env.DB.exec(CREATE_MEMBERS.replace(/\n\s*/g, " "));
	await env.DB.exec("DELETE FROM teams");
	await env.DB.exec("DELETE FROM members");
});

function spySandbox(writes: Array<{ path: string; content: string }>): {
	sandbox: ForgeInjectableSandbox;
} {
	return {
		sandbox: {
			writeFile: async (path: string, content: string) => {
				writes.push({ path, content });
				return {};
			},
		},
	};
}

async function addMember(id: string, login: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO members (id, github_login, created_at) VALUES (?1, ?2, ?3)",
	)
		.bind(id, login, "2026-01-01T00:00:00Z")
		.run();
}

describe("reinjectForgeMembersIfServing (P1-4a guard semantics)", () => {
	it("SERVING container → rewrites the members file with the collected creds", async () => {
		await addMember("100", "creator-login");
		// Bind the creator + store their token through the REAL store, so the
		// injected payload comes from the real collect path.
		const store = createWorkerTeamGatewayStore(
			env as unknown as TestEnv,
			new URL("https://team.test/"),
			{ reinjectForgeCreds: async () => {}, restartForReauth: async () => {} },
		);
		await store.putForgeIdentity("100", { githubToken: "gho_live_reinject" });

		const writes: Array<{ path: string; content: string }> = [];
		const { sandbox } = spySandbox(writes);
		await reinjectForgeMembersIfServing(
			sandbox,
			env as unknown as TestEnv,
			async () => true,
		);

		expect(writes).toHaveLength(1);
		expect(writes[0].path).toBe(FORGE_MEMBERS_PATH);
		const creds = JSON.parse(writes[0].content) as Record<
			string,
			{ githubToken?: string; creator?: boolean }
		>;
		expect(creds["100"]).toMatchObject({
			githubToken: "gho_live_reinject",
			creator: true,
		});
	});

	it("NOT serving → skips entirely (no container touch)", async () => {
		const writes: Array<{ path: string; content: string }> = [];
		const { sandbox } = spySandbox(writes);
		await reinjectForgeMembersIfServing(
			sandbox,
			env as unknown as TestEnv,
			async () => false,
		);
		expect(writes).toHaveLength(0);
	});

	it("is best-effort: a throwing probe or write never rejects", async () => {
		const { sandbox } = spySandbox([]);
		await expect(
			reinjectForgeMembersIfServing(sandbox, env as unknown as TestEnv, () =>
				Promise.reject(new Error("probe boom")),
			),
		).resolves.toBeUndefined();

		const failingSandbox: ForgeInjectableSandbox = {
			writeFile: () => Promise.reject(new Error("write boom")),
		};
		await expect(
			reinjectForgeMembersIfServing(
				failingSandbox,
				env as unknown as TestEnv,
				async () => true,
			),
		).resolves.toBeUndefined();
	});
});

describe("PUT /team/forge-identity wiring (P1-4a)", () => {
	it("fires the live re-inject hook on every successful PUT", async () => {
		let reinjects = 0;
		const deps: TeamGatewayStoreDeps = {
			reinjectForgeCreds: async () => {
				reinjects += 1;
			},
			restartForReauth: async () => {
				throw new Error("forge PUT must never restart the container");
			},
		};
		const store = createWorkerTeamGatewayStore(
			env as unknown as TestEnv,
			new URL("https://team.test/"),
			deps,
		);

		await store.putForgeIdentity("100", { githubToken: "gho_first" });
		expect(reinjects).toBe(1);

		// UNCONDITIONAL (no `changed` gate): a re-PUT of the same token still
		// re-injects — cheap, idempotent, self-heals an earlier failed write.
		await store.putForgeIdentity("100", { githubToken: "gho_first" });
		expect(reinjects).toBe(2);
	});
});
