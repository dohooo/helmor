/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Lever A: the D1 workspace-detail mirror. The container pushes the exact
// `get_workspace` WorkspaceDetail serialization over PUT /team/sync
// (`workspaceDetails: [{workspaceId, detail}]`); the Worker stores it opaque
// (write-path self-heal CREATE — no migration step for existing deployments)
// and serves it via GET /team/workspace-detail so team mode answers the
// switch-time detail read with the container ASLEEP. These tests pin the
// D1 store semantics against the REAL in-memory D1 (`DB` binding).

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

function makeStore() {
	return createWorkerTeamGatewayStore(
		env as unknown as Env,
		new URL("http://127.0.0.1:8787/"),
	);
}

beforeEach(async () => {
	// The table is write-path self-healed; only clear it if a prior test
	// created it (mirrors a pre-Lever-A deployment on first run).
	try {
		await env.DB.exec("DELETE FROM workspace_details");
	} catch {
		// Table not created yet — exactly the fresh-deployment state.
	}
});

describe("D1 workspace-detail mirror (Lever A)", () => {
	it("round-trips the opaque detail payload through sync → read", async () => {
		const store = makeStore();
		const detail = {
			id: "w1",
			title: "Feature branch",
			mode: "worktree",
			state: "ready",
			branch: "feature/x",
			activeSessionId: "s1",
			prSyncState: "open",
		};
		await store.syncTeamData({
			workspaceDetails: [{ workspaceId: "w1", detail }],
		});

		// Byte-for-byte opaque: the store must not reshape the payload.
		expect(await store.getWorkspaceDetail("w1")).toEqual(detail);
	});

	it("self-heals the table on first write (fresh/pre-Lever-A deployment)", async () => {
		// beforeEach may have left the DB without the table; a bare read must
		// answer null (not throw), and the first sync must create the table.
		const store = makeStore();
		expect(await store.getWorkspaceDetail("w1")).toBeNull();
		await store.syncTeamData({
			workspaceDetails: [{ workspaceId: "w1", detail: { id: "w1" } }],
		});
		expect(await store.getWorkspaceDetail("w1")).toEqual({ id: "w1" });
	});

	it("upserts: a re-push overwrites the previous detail for the workspace", async () => {
		const store = makeStore();
		await store.syncTeamData({
			workspaceDetails: [
				{ workspaceId: "w1", detail: { id: "w1", title: "Old" } },
			],
		});
		await store.syncTeamData({
			workspaceDetails: [
				{ workspaceId: "w1", detail: { id: "w1", title: "Renamed" } },
			],
		});
		expect(await store.getWorkspaceDetail("w1")).toEqual({
			id: "w1",
			title: "Renamed",
		});
	});

	it("batches multiple workspaces in one sync (the All target / backfill)", async () => {
		const store = makeStore();
		await store.syncTeamData({
			workspaceDetails: [
				{ workspaceId: "w1", detail: { id: "w1" } },
				{ workspaceId: "w2", detail: { id: "w2" } },
			],
		});
		expect(await store.getWorkspaceDetail("w1")).toEqual({ id: "w1" });
		expect(await store.getWorkspaceDetail("w2")).toEqual({ id: "w2" });
	});

	it("answers null for an unknown workspace and skips malformed rows", async () => {
		const store = makeStore();
		await store.syncTeamData({
			workspaceDetails: [
				// Malformed rows are skipped, never thrown on (best-effort sync).
				{ workspaceId: "", detail: { id: "w-empty" } },
				{ workspaceId: "w-null", detail: null },
			],
		});
		expect(await store.getWorkspaceDetail("nope")).toBeNull();
		expect(await store.getWorkspaceDetail("w-null")).toBeNull();
	});
});
