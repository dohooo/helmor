/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Round6 P1-2a suite: the forge "creator" binding + creator-only injection.
//
// The user product ruling keeps the creator-identity model (everyone's pushes
// reuse the creator's forge identity) and narrows ONLY how tokens are stored:
// the container gets the creator's tokens and nothing else. These tests pin:
//   (1) PUT /team/forge-identity binds `teams.forge_identity_member_id`
//       FIRST-authorizer-wins (a later member's PUT stores their DO but never
//       rebinds the column),
//   (2) collectMemberForgeCreds injects tokens ONLY for the creator entry
//       (flagged `creator: true`); every other member is login-only,
//   (3) no creator bound → no tokens injected at all.
//
// Runs inside workerd with the real ForgeIdentity DO (AES-GCM at rest) and a
// real in-memory D1.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { collectMemberForgeCreds } from "../src/index";
import { readForgeIdentityMemberId } from "../src/team";

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

async function addMember(id: string, login: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO members (id, github_login, created_at) VALUES (?1, ?2, ?3)",
	)
		.bind(id, login, "2026-01-01T00:00:00Z")
		.run();
}

/** Drive the REAL putForgeIdentity through the exported gateway store. */
async function putForge(memberId: string, githubToken: string): Promise<void> {
	const { createWorkerTeamGatewayStore } = await import("../src/team");
	const store = createWorkerTeamGatewayStore(
		env as unknown as TestEnv,
		new URL("https://team.test/"),
	);
	await store.putForgeIdentity(memberId, { githubToken });
}

describe("forge creator binding (P1-2a)", () => {
	it("binds the FIRST authorizer and never rebinds on a later PUT", async () => {
		await putForge("100", "gho_first");
		expect(await readForgeIdentityMemberId(env as unknown as TestEnv)).toBe(
			"100",
		);

		// A second member authorizing later stores their DO but must NOT steal
		// the binding (first-authorizer-wins; accepted TOFU edge).
		await putForge("200", "gho_second");
		expect(await readForgeIdentityMemberId(env as unknown as TestEnv)).toBe(
			"100",
		);
	});

	it("injects tokens ONLY for the creator; other members are login-only", async () => {
		await addMember("100", "creator-login");
		await addMember("200", "member-login");
		await putForge("100", "gho_creator");
		await putForge("200", "gho_second");

		const creds = await collectMemberForgeCreds(env as unknown as TestEnv);

		// Creator: tokens + flag.
		expect(creds["100"]).toMatchObject({
			githubToken: "gho_creator",
			login: "creator-login",
			creator: true,
		});
		// Non-creator: login for commit authorship, NO token material even
		// though their DO holds one — the container never sees it.
		expect(creds["200"]).toBeDefined();
		expect(creds["200"].login).toBe("member-login");
		expect(creds["200"].githubToken).toBeUndefined();
		expect(creds["200"].glabConfigYml).toBeUndefined();
		expect(creds["200"].creator).toBeUndefined();

		// Belt-and-suspenders: the creator token appears exactly once in the
		// whole injected payload.
		const serialized = JSON.stringify(creds);
		expect(serialized.match(/gho_creator/g)).toHaveLength(1);
		expect(serialized).not.toContain("gho_second");
	});

	it("injects no tokens when no member has authorized forge", async () => {
		await addMember("100", "creator-login");
		const creds = await collectMemberForgeCreds(env as unknown as TestEnv);
		expect(JSON.stringify(creds)).not.toContain("Token");
		expect(creds["100"]).toEqual({ login: "creator-login" });
	});
});
