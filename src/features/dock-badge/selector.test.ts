import { describe, expect, it } from "vitest";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { selectUnreadSessionCount } from "./selector";

function row(
	id: string,
	values: Pick<WorkspaceRow, "workspaceUnread" | "unreadSessionCount"> = {},
): WorkspaceRow {
	return {
		id,
		title: id,
		state: "ready",
		status: "in-progress",
		...values,
	};
}

function group(id: string, rows: WorkspaceRow[]): WorkspaceGroup {
	return { id, label: id, tone: "progress", rows };
}

describe("selectUnreadSessionCount", () => {
	it("returns 0 when groups is undefined", () => {
		expect(selectUnreadSessionCount(undefined)).toBe(0);
	});

	it("returns 0 when groups is null", () => {
		expect(selectUnreadSessionCount(null)).toBe(0);
	});

	it("returns 0 when all groups are empty", () => {
		expect(selectUnreadSessionCount([group("a", []), group("b", [])])).toBe(0);
	});

	it("returns 0 when no row has unread sessions", () => {
		expect(
			selectUnreadSessionCount([
				group("a", [
					row("ws-1", { unreadSessionCount: 0 }),
					row("ws-2", { unreadSessionCount: 0 }),
				]),
			]),
		).toBe(0);
	});

	it("treats missing unreadSessionCount as 0", () => {
		expect(
			selectUnreadSessionCount([
				group("a", [row("ws-1"), row("ws-2", { unreadSessionCount: 3 })]),
			]),
		).toBe(3);
	});

	it("ignores workspaceUnread because it is purely derived", () => {
		// Even with a non-zero workspaceUnread flag, the badge counts only
		// sessions — the backend keeps `workspaceUnread` in lockstep with
		// `unreadSessionCount`, so honoring both would double-count.
		expect(
			selectUnreadSessionCount([
				group("a", [
					row("ws-1", { unreadSessionCount: 3, workspaceUnread: 1 }),
					row("ws-2", { unreadSessionCount: 2, workspaceUnread: 0 }),
					row("ws-3", { unreadSessionCount: 0, workspaceUnread: 1 }),
					row("ws-4", { unreadSessionCount: 0, workspaceUnread: 0 }),
				]),
			]),
		).toBe(5);
	});

	it("sums unreadSessionCount across rows", () => {
		expect(
			selectUnreadSessionCount([
				group("a", [
					row("ws-1", { unreadSessionCount: 1 }),
					row("ws-2", { unreadSessionCount: 2 }),
					row("ws-3", { unreadSessionCount: 0 }),
				]),
			]),
		).toBe(3);
	});

	it("does not cap the total — macOS handles large values itself", () => {
		const manyRows = Array.from({ length: 150 }, (_, i) =>
			row(`ws-${i}`, { unreadSessionCount: 1 }),
		);
		expect(selectUnreadSessionCount([group("a", manyRows)])).toBe(150);
	});
});
