/// <reference types="@cloudflare/vitest-pool-workers/types" />
// handleTeamClone D1 workspaces-mirror suite (PREVIEW A5).
//
// After a SUCCESSFUL `add_repository_from_local_path` register RPC, the Worker
// upserts the team's D1 `workspaces` mirror so `GET /team/workspaces` lists the
// new repo in the sidebar. The mirror write is BEST-EFFORT — it must never break
// the clone — so these tests pin the three contractually-required behaviors:
//   (1) a row lands on register-success (id = selectedWorkspaceId ?? repositoryId),
//   (2) NO write on register-failure (the clone dir is cleaned up instead),
//   (3) a duplicate clone UPSERTS the existing row (name/status refreshed).
//
// Runs inside workerd via @cloudflare/vitest-pool-workers against a REAL in-
// memory D1 (the `DB` binding in vitest.config.ts). The container `Sandbox` is
// faked down to just the three methods handleTeamClone calls (gitCheckout,
// containerFetch, exec) so the test never needs the `[[containers]]` image.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTeamClone } from "../src/index";
import { TEAM_ID } from "../src/team";

// The ambient `Cloudflare.Env` (from cloudflare:workers) doesn't declare the
// test-only `DB` binding wired in vitest.config.ts — surface it for `env.DB`.
declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
	}
}

// The `workspaces` table mirrors ./schema.sql. Recreated + cleared per test so
// each case starts from an empty mirror (isolatedStorage gives clean DO storage,
// but the table itself must exist before the first write).
const CREATE_WORKSPACES = `CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

beforeEach(async () => {
	await env.DB.exec(CREATE_WORKSPACES.replace(/\n\s*/g, " "));
	await env.DB.exec("DELETE FROM workspaces");
});

type WorkspaceRow = {
	id: string;
	team_id: string;
	name: string;
	status: string;
	created_at: string;
};

async function allWorkspaces(): Promise<WorkspaceRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT id, team_id, name, status, created_at FROM workspaces ORDER BY id",
	).all<WorkspaceRow>();
	return results;
}

/** The request the Worker's proxy hands handleTeamClone: a POST carrying the
 *  clone body, with the derived member auth already on it. */
function forwardedClone(gitUrl: string): Request {
	return new Request("https://team.test/rpc/clone_repository_from_url", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: "Bearer member-token",
		},
		body: JSON.stringify({ gitUrl }),
	});
}

type RegisterOutcome =
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; status: number };

/** A fake container Sandbox covering only the methods handleTeamClone calls.
 *  `gitCheckout` succeeds (the clone landing is not under test here — the mirror
 *  write keys off the REGISTER result), `containerFetch` answers the register
 *  RPC per `register`, and `exec` records the cleanup call. */
function fakeSandbox(register: RegisterOutcome): {
	sandbox: import("@cloudflare/sandbox").Sandbox;
	execCalls: string[];
} {
	const execCalls: string[] = [];
	const sandbox = {
		gitCheckout: async () => ({ success: true, exitCode: 0 }),
		containerFetch: async () =>
			register.ok
				? new Response(JSON.stringify(register.body), {
						status: 200,
						headers: { "content-type": "application/json" },
					})
				: new Response(JSON.stringify({ code: "Internal" }), {
						status: register.status,
						headers: { "content-type": "application/json" },
					}),
		exec: async (cmd: string) => {
			execCalls.push(cmd);
			return { success: true };
		},
	} as unknown as import("@cloudflare/sandbox").Sandbox;
	return { sandbox, execCalls };
}

describe("handleTeamClone — D1 workspaces mirror", () => {
	it("upserts a row on register-success (id = selectedWorkspaceId)", async () => {
		const { sandbox } = fakeSandbox({
			ok: true,
			body: {
				repositoryId: "repo-1",
				createdRepository: true,
				selectedWorkspaceId: "ws-1",
			},
		});

		const res = await handleTeamClone(
			forwardedClone("https://github.com/acme/foo.git"),
			sandbox,
			8080,
			env as unknown as import("../src/index").Env,
		);
		expect(res.status).toBe(200);

		const rows = await allWorkspaces();
		expect(rows).toHaveLength(1);
		// selectedWorkspaceId wins over repositoryId for the row id.
		expect(rows[0]).toMatchObject({
			id: "ws-1",
			team_id: TEAM_ID,
			name: "foo", // inferRepoName("…/foo.git")
			status: "active",
		});
		expect(rows[0].created_at).toBeTruthy();
	});

	it("falls back to repositoryId when selectedWorkspaceId is null", async () => {
		const { sandbox } = fakeSandbox({
			ok: true,
			body: {
				repositoryId: "repo-2",
				createdRepository: true,
				selectedWorkspaceId: null,
			},
		});

		await handleTeamClone(
			forwardedClone("https://github.com/acme/bar"),
			sandbox,
			8080,
			env as unknown as import("../src/index").Env,
		);

		const rows = await allWorkspaces();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "repo-2",
			team_id: TEAM_ID,
			name: "bar",
			status: "active",
		});
	});

	it("does NOT write the mirror on register-failure (and cleans up the dir)", async () => {
		const { sandbox, execCalls } = fakeSandbox({ ok: false, status: 500 });

		const res = await handleTeamClone(
			forwardedClone("https://github.com/acme/baz.git"),
			sandbox,
			8080,
			env as unknown as import("../src/index").Env,
		);
		// The register failure passes through verbatim.
		expect(res.status).toBe(500);

		// No mirror row, and the orphaned clone dir was removed best-effort.
		expect(await allWorkspaces()).toHaveLength(0);
		expect(execCalls.some((c) => c.startsWith("rm -rf "))).toBe(true);
	});

	it("upserts (does not duplicate) on a repeated clone of the same workspace", async () => {
		// First clone: lands the row.
		const first = fakeSandbox({
			ok: true,
			body: {
				repositoryId: "repo-3",
				createdRepository: true,
				selectedWorkspaceId: "ws-3",
			},
		});
		await handleTeamClone(
			forwardedClone("https://github.com/acme/dup.git"),
			first.sandbox,
			8080,
			env as unknown as import("../src/index").Env,
		);

		// Second clone resolves to the SAME id (ws-3) but a different repo name;
		// the ON CONFLICT(id) path must refresh name/status, not insert a 2nd row.
		const second = fakeSandbox({
			ok: true,
			body: {
				repositoryId: "repo-3",
				createdRepository: false,
				selectedWorkspaceId: "ws-3",
			},
		});
		await handleTeamClone(
			forwardedClone("https://github.com/acme/renamed.git"),
			second.sandbox,
			8080,
			env as unknown as import("../src/index").Env,
		);

		const rows = await allWorkspaces();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "ws-3",
			team_id: TEAM_ID,
			name: "renamed", // refreshed by the upsert
			status: "active",
		});
	});
});
