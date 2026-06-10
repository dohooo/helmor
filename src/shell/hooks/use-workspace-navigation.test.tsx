import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { SCHEDULE_AFTER_PAINT_FALLBACK_MS } from "@/lib/schedule-after-paint";
import type { SelectionActions } from "@/shell/controllers/use-selection-controller";
import { useWorkspaceNavigation } from "./use-workspace-navigation";

// The hook queries `[data-helmor-sidebar-root]` document-wide; unmount each
// test's fixture (no auto-cleanup here — vitest globals are disabled) so the
// next test's queries can't hit a stale, already-mutated sidebar.
afterEach(cleanup);

// The workspace commit is deferred out of the keydown task (rAF →
// setTimeout(0) raced against the fallback timer). rAF is left un-stubbed —
// jsdom doesn't dispatch frames — so flushing the fallback timer is the
// deterministic way to land the deferred commit.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const flushDeferredCommit = () =>
	vi.advanceTimersByTime(SCHEDULE_AFTER_PAINT_FALLBACK_MS);

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
		rows: [
			{ id: "ws-A" } as WorkspaceRow,
			{ id: "ws-B" } as WorkspaceRow,
			{ id: "ws-C" } as WorkspaceRow,
		],
	} as WorkspaceGroup,
];

function renderNavigation(
	selectionActions: SelectionActions,
	handleSelectWorkspace = vi.fn(),
) {
	const { result } = renderHook(() =>
		useWorkspaceNavigation({
			queryClient: new QueryClient(),
			selectionActions,
			workspaceGroups,
			archivedRows: [],
			handleSelectWorkspace,
			handleSelectSession: vi.fn(),
		}),
	);
	return { result, handleSelectWorkspace };
}

const rowHasHighlight = (workspaceId: string) =>
	document
		.querySelector(`[data-workspace-row-id="${workspaceId}"]`)
		?.classList.contains("workspace-row-selected") ?? false;

function renderSidebarFixture() {
	render(
		<div data-helmor-sidebar-root="">
			<div
				data-workspace-row-body=""
				data-workspace-row-id="ws-A"
				className="workspace-row-selected"
			/>
			<div data-workspace-row-body="" data-workspace-row-id="ws-B" />
			<div data-workspace-row-body="" data-workspace-row-id="ws-C" />
		</div>,
	);
}

describe("useWorkspaceNavigation", () => {
	// Two-track keyboard contract: the keydown task moves the imperative
	// sidebar highlight synchronously; the router/selection commit lands in
	// the deferred post-paint task, exactly once.
	it("moves the highlight synchronously and defers the selection commit", () => {
		renderSidebarFixture();
		const highlightAtCall: Array<{ previous: boolean; target: boolean }> = [];
		const handleSelectWorkspace = vi.fn(() => {
			highlightAtCall.push({
				previous: rowHasHighlight("ws-A"),
				target: rowHasHighlight("ws-B"),
			});
		});
		const { result } = renderNavigation(
			buildSelectionActions("ws-A"),
			handleSelectWorkspace,
		);

		result.current.handleNavigateWorkspaces(1);

		// Inside the keydown task: highlight already moved, commit not yet run.
		expect(rowHasHighlight("ws-B")).toBe(true);
		expect(rowHasHighlight("ws-A")).toBe(false);
		expect(handleSelectWorkspace).not.toHaveBeenCalled();

		flushDeferredCommit();

		expect(handleSelectWorkspace).toHaveBeenCalledTimes(1);
		expect(handleSelectWorkspace).toHaveBeenCalledWith("ws-B");
		// The highlight was already in place when the deferred commit ran.
		expect(highlightAtCall).toEqual([{ previous: false, target: true }]);
	});

	it("chains rapid taps off the pending target and commits only the landing workspace", () => {
		renderSidebarFixture();
		const { result, handleSelectWorkspace } = renderNavigation(
			buildSelectionActions("ws-A"),
		);

		result.current.handleNavigateWorkspaces(1); // A -> B (pending)
		result.current.handleNavigateWorkspaces(1); // chains B -> C

		// The highlight stepped with each tap…
		expect(rowHasHighlight("ws-C")).toBe(true);
		expect(rowHasHighlight("ws-B")).toBe(false);

		flushDeferredCommit();

		// …but only the landing workspace commits.
		expect(handleSelectWorkspace).toHaveBeenCalledTimes(1);
		expect(handleSelectWorkspace).toHaveBeenCalledWith("ws-C");
	});

	it("drops a pending chain when another input path navigates first", () => {
		renderSidebarFixture();
		let routerWorkspaceId = "ws-A";
		const selectionActions = {
			getSnapshot: () => ({
				workspaceId: routerWorkspaceId,
				sessionId: null,
				viewMode: "conversation" as const,
			}),
		} as unknown as SelectionActions;
		const { result, handleSelectWorkspace } =
			renderNavigation(selectionActions);

		result.current.handleNavigateWorkspaces(1); // A -> B (pending)
		// A mouse click (or quick-switch) lands somewhere else before the
		// deferred commit runs — its intent wins.
		routerWorkspaceId = "ws-C";

		flushDeferredCommit();

		expect(handleSelectWorkspace).not.toHaveBeenCalled();
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
				<div data-workspace-row-body="" data-workspace-row-id="ws-C" />
			</div>,
		);
		const { result, handleSelectWorkspace } = renderNavigation(
			buildSelectionActions("ws-C"),
		);

		// ws-C is the last row; navigating further is a no-op and must not
		// strip the current row's highlight either.
		result.current.handleNavigateWorkspaces(1);
		flushDeferredCommit();

		expect(handleSelectWorkspace).not.toHaveBeenCalled();
		expect(rowHasHighlight("ws-A")).toBe(true);
	});
});
