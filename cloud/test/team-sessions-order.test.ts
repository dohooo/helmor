/// <reference types="@cloudflare/vitest-pool-workers/types" />
// DF-2 session-ordering suite: the D1 sessions mirror historically held TWO
// `created_at` formats — the container schema default `datetime('now')`
// ("2026-07-06 11:01:04") and the Rust `current_timestamp()` RFC 3339 output
// ("2026-07-06T10:54:52.822Z"). A raw-string ORDER BY compares ' ' (0x20) <
// 'T' (0x54), so same-day space-format rows always sorted BEFORE ISO rows —
// a fresh session landed at the top of the tab strip. These tests pin:
//   (1) mixed-format stock sorts chronologically (datetime() read normalization),
//   (2) a re-sync propagates the container's normalized created_at (upsert
//       follows the container byte-for-byte),
//   (3) a null payload created_at never clobbers a good mirror value.
//
// Runs against the REAL in-memory D1 (`DB` binding in vitest.config.ts).

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { createWorkerTeamGatewayStore } from "../src/team";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
	}
}

const CREATE_SESSIONS = `CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  title                TEXT,
  status               TEXT,
  model                TEXT,
  agent_type           TEXT,
  permission_mode      TEXT,
  effort_level         TEXT,
  action_kind          TEXT,
  session_kind         TEXT,
  is_hidden            INTEGER NOT NULL DEFAULT 0,
  last_user_message_at TEXT,
  created_at           TEXT,
  updated_at           TEXT
)`;

const CREATE_MESSAGES = `CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT,
  content    TEXT,
  sent_at    TEXT,
  created_at TEXT,
  author_id  TEXT
)`;

function makeStore() {
	return createWorkerTeamGatewayStore(
		env as unknown as Env,
		new URL("http://127.0.0.1:8787/"),
	);
}

async function listIds(workspaceId: string): Promise<string[]> {
	const sessions = (await makeStore().listSessions(workspaceId)) as Array<{
		id: string;
	}>;
	return sessions.map((s) => s.id);
}

async function readCreatedAt(id: string): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT created_at FROM sessions WHERE id = ?1",
	)
		.bind(id)
		.first<{ created_at: string | null }>();
	return row?.created_at ?? null;
}

beforeEach(async () => {
	await env.DB.exec(CREATE_SESSIONS.replace(/\n\s*/g, " "));
	await env.DB.exec(CREATE_MESSAGES.replace(/\n\s*/g, " "));
	await env.DB.exec("DELETE FROM sessions");
	await env.DB.exec("DELETE FROM messages");
});

describe("D1 session mirror ordering (DF-2)", () => {
	it("sorts mixed legacy/ISO created_at formats chronologically", async () => {
		// Stock rows as dogfooding found them: an OLDER ISO seed session and a
		// NEWER space-format "New session" row. Raw string order would put the
		// newer row first ('2026-07-06 …' < '2026-07-06T…').
		await makeStore().syncTeamData({
			sessions: [
				{
					id: "s-new",
					workspaceId: "w1",
					createdAt: "2026-07-06 11:01:04",
				},
				{
					id: "s-old",
					workspaceId: "w1",
					createdAt: "2026-07-06T10:54:52.822Z",
				},
			],
		});

		expect(await listIds("w1")).toEqual(["s-old", "s-new"]);
	});

	it("re-sync propagates the container's normalized created_at", async () => {
		const store = makeStore();
		await store.syncTeamData({
			sessions: [
				{ id: "s1", workspaceId: "w1", createdAt: "2026-07-06 11:01:04" },
			],
		});
		// Container migration normalized the row; the next sync must follow.
		await store.syncTeamData({
			sessions: [
				{ id: "s1", workspaceId: "w1", createdAt: "2026-07-06T11:01:04.000Z" },
			],
		});

		expect(await readCreatedAt("s1")).toBe("2026-07-06T11:01:04.000Z");
	});

	it("null created_at on re-sync never clobbers a good mirror value", async () => {
		const store = makeStore();
		await store.syncTeamData({
			sessions: [
				{ id: "s1", workspaceId: "w1", createdAt: "2026-07-06T11:01:04.000Z" },
			],
		});
		await store.syncTeamData({
			sessions: [{ id: "s1", workspaceId: "w1", createdAt: null }],
		});

		expect(await readCreatedAt("s1")).toBe("2026-07-06T11:01:04.000Z");
	});
});
