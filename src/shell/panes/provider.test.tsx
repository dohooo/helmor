import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { initialPanesState, panesReducer, PanesProvider, usePanes } from "./provider";

describe("panesReducer", () => {
	it("seeds with a single default pane targeting main", () => {
		const state = initialPanesState();
		expect(state.panes).toHaveLength(1);
		expect(state.panes[0]).toMatchObject({
			id: "default",
			workspaceId: null,
			sessionId: null,
			target: "main",
		});
		expect(state.focusedPaneId).toBe("default");
	});

	it("replaceTarget updates only workspaceId + sessionId on the matched pane", () => {
		const state = initialPanesState();
		const next = panesReducer(state, {
			type: "replaceTarget",
			paneId: "default",
			workspaceId: "ws-a",
			sessionId: "s-x",
		});
		expect(next.panes[0]).toEqual({
			id: "default",
			workspaceId: "ws-a",
			sessionId: "s-x",
			target: "main",
		});
		expect(next.focusedPaneId).toBe("default");
	});

	it("replaceTarget on an unknown id is a no-op", () => {
		const state = initialPanesState();
		const next = panesReducer(state, {
			type: "replaceTarget",
			paneId: "missing",
			workspaceId: "ws-a",
			sessionId: "s-x",
		});
		expect(next).toBe(state);
	});

	it("returns the same object when nothing changed", () => {
		const state = initialPanesState();
		const next = panesReducer(state, {
			type: "replaceTarget",
			paneId: "default",
			workspaceId: null,
			sessionId: null,
		});
		expect(next).toBe(state);
	});
});

describe("PanesProvider", () => {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<PanesProvider>{children}</PanesProvider>
	);

	it("exposes the seeded single pane", () => {
		const { result } = renderHook(() => usePanes(), { wrapper });
		expect(result.current.panes).toHaveLength(1);
		expect(result.current.focusedPaneId).toBe("default");
	});

	it("replaceTarget swaps the pane's workspace + session", () => {
		const { result } = renderHook(() => usePanes(), { wrapper });
		act(() => {
			result.current.replaceTarget("default", {
				workspaceId: "ws-a",
				sessionId: "s-x",
			});
		});
		expect(result.current.panes[0]).toMatchObject({
			workspaceId: "ws-a",
			sessionId: "s-x",
		});
	});

	it("usePanes throws when used outside the provider", () => {
		expect(() => renderHook(() => usePanes())).toThrowError(
			/usePanes must be used inside <PanesProvider>/,
		);
	});
});
