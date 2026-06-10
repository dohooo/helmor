import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import type { SelectionActions } from "@/shell/controllers/use-selection-controller";
import { useWorkspaceNavigation } from "./use-workspace-navigation";

// The hook queries `[data-helmor-sidebar-root]` document-wide; unmount each
// test's fixture (no auto-cleanup here — vitest globals are disabled) so the
// next test's queries can't hit a stale, already-mutated sidebar.
afterEach(cleanup);

function buildSelectionActions(workspaceId: string | null): SelectionActions {
	return {
		getSnapshot: () => ({
			workspaceId,
			sessionId: null,
			viewMode: "conversation" as const,
		}),
	} as unknown as SelectionActions;
}

const workspaceGroups = [
	{
		tone: "progress",
		rows: [{ id: "ws-A" } as WorkspaceRow, { id: "ws-B" } as WorkspaceRow],
	} as WorkspaceGroup,
];

describe("useWorkspaceNavigation", () => {
	// Stage A keyboard wiring pin: the imperative sidebar highlight must land
	// inside the keydown task BEFORE the selection handler runs, mirroring the
	// sidebar's pointerdown preview ordering.
	it("applies the immediate sidebar highlight before invoking handleSelectWorkspace", () => {
		render(
			<div data-helmor-sidebar-root="">
				<div
					data-workspace-row-body=""
					data-workspace-row-id="ws-A"
					className="workspace-row-selected"
				/>
				<div data-workspace-row-body="" data-workspace-row-id="ws-B" />
			</div>,
		);
		const rowHasHighlight = (workspaceId: string) =>
			document
				.querySelector(`[data-workspace-row-id="${workspaceId}"]`)
				?.classList.contains("workspace-row-selected") ?? false;

		const highlightAtCall: Array<{ previous: boolean; target: boolean }> = [];
		const handleSelectWorkspace = vi.fn(() => {
			highlightAtCall.push({
				previous: rowHasHighlight("ws-A"),
				target: rowHasHighlight("ws-B"),
			});
		});

		const { result } = renderHook(() =>
			useWorkspaceNavigation({
				queryClient: new QueryClient(),
				selectionActions: buildSelectionActions("ws-A"),
				workspaceGroups,
				archivedRows: [],
				handleSelectWorkspace,
				handleSelectSession: vi.fn(),
			}),
		);

		result.current.handleNavigateWorkspaces(1);

		expect(handleSelectWorkspace).toHaveBeenCalledTimes(1);
		expect(handleSelectWorkspace).toHaveBeenCalledWith("ws-B");
		// The target row already carried the class — and the previous row had
		// lost it — when the handler was invoked.
		expect(highlightAtCall).toEqual([{ previous: false, target: true }]);
	});

	it("no-ops without touching the highlight when there is no adjacent workspace", () => {
		render(
			<div data-helmor-sidebar-root="">
				<div
					data-workspace-row-body=""
					data-workspace-row-id="ws-A"
					className="workspace-row-selected"
				/>
				<div data-workspace-row-body="" data-workspace-row-id="ws-B" />
			</div>,
		);
		const handleSelectWorkspace = vi.fn();

		const { result } = renderHook(() =>
			useWorkspaceNavigation({
				queryClient: new QueryClient(),
				selectionActions: buildSelectionActions("ws-B"),
				workspaceGroups,
				archivedRows: [],
				handleSelectWorkspace,
				handleSelectSession: vi.fn(),
			}),
		);

		// ws-B is the last row; navigating further is a no-op and must not
		// strip the current row's highlight either.
		result.current.handleNavigateWorkspaces(1);

		expect(handleSelectWorkspace).not.toHaveBeenCalled();
		expect(
			document
				.querySelector('[data-workspace-row-id="ws-A"]')
				?.classList.contains("workspace-row-selected"),
		).toBe(true);
	});
});
