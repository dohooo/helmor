import { describe, expect, it } from "vitest";
import type { WorkspaceRow } from "@/lib/api";
import { deriveWorkspaceStatusDot } from "./workspace-status-display";

function makeRow(extra?: Partial<WorkspaceRow>): WorkspaceRow {
	return { id: "ws-1", title: "Workspace", ...extra };
}

describe("deriveWorkspaceStatusDot", () => {
	it("uses the workflow status when present", () => {
		const dot = deriveWorkspaceStatusDot(makeRow({ status: "review" }));
		expect(dot.label).toBe("In review");
		expect(dot.dotClass).toContain("review");
	});

	it("falls back to in-progress when status is missing", () => {
		const dot = deriveWorkspaceStatusDot(makeRow());
		expect(dot.label).toBe("In progress");
		expect(dot.dotClass).toContain("progress");
	});

	it("falls back to in-progress for legacy / unknown status strings", () => {
		// Old DBs may carry "in-review" / "cancelled" — backend migration
		// normalizes them, but the helper must stay safe in the meantime,
		// otherwise the dot renders class-less and reads as transparent.
		for (const legacy of ["in-review", "cancelled", "weird-value", ""]) {
			const dot = deriveWorkspaceStatusDot(
				makeRow({ status: legacy as WorkspaceRow["status"] }),
			);
			expect(dot.label).toBe("In progress");
			expect(dot.dotClass).toContain("progress");
		}
	});

	it("ignores pinned — pinned and un-pinned rows resolve to identical dots", () => {
		// Pinned is a grouping signal on the sidebar, not a status. The
		// hover card has always rendered the dot the same way on pinned
		// and un-pinned rows; this helper must keep that invariant.
		const unpinned = deriveWorkspaceStatusDot(makeRow({ status: "review" }));
		const pinned = deriveWorkspaceStatusDot(
			makeRow({ status: "review", pinnedAt: "2025-01-01T00:00:00Z" }),
		);
		expect(pinned).toEqual(unpinned);
	});
});
