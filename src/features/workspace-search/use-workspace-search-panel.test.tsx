import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceSearchPanel } from "./use-workspace-search-panel";

describe("useWorkspaceSearchPanel", () => {
	beforeEach(() => {
		// Nothing — the hook is self-contained.
	});

	afterEach(() => {
		// Nothing — no globals to reset.
	});

	it("starts closed", () => {
		const { result } = renderHook(() => useWorkspaceSearchPanel());
		expect(result.current.isOpen).toBe(false);
	});

	it("open() flips to open, close() flips back", () => {
		const { result } = renderHook(() => useWorkspaceSearchPanel());
		act(() => result.current.open());
		expect(result.current.isOpen).toBe(true);
		act(() => result.current.close());
		expect(result.current.isOpen).toBe(false);
	});

	it("toggle() inverts the current state", () => {
		const { result } = renderHook(() => useWorkspaceSearchPanel());
		act(() => result.current.toggle());
		expect(result.current.isOpen).toBe(true);
		act(() => result.current.toggle());
		expect(result.current.isOpen).toBe(false);
	});

	it("Escape closes the panel when open", () => {
		const { result } = renderHook(() => useWorkspaceSearchPanel());
		act(() => result.current.open());
		expect(result.current.isOpen).toBe(true);

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});

		expect(result.current.isOpen).toBe(false);
	});

	it("Escape is a no-op when the panel is already closed", () => {
		// The Escape handler only registers while open; verify a stray
		// Escape press doesn't crash + the state stays closed.
		const { result } = renderHook(() => useWorkspaceSearchPanel());
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(result.current.isOpen).toBe(false);
	});

	it("non-Escape keys do not close the panel", () => {
		// The handler should ignore everything except Escape so the
		// user can type into the search input without the panel
		// closing on every keystroke.
		const { result } = renderHook(() => useWorkspaceSearchPanel());
		act(() => result.current.open());
		for (const key of ["a", "ArrowDown", "Enter", "Tab", " "]) {
			act(() => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key }));
			});
		}
		expect(result.current.isOpen).toBe(true);
	});
});
