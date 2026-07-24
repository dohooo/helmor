import { focusManager } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpTransportGeneration } from "@/lib/transport-generation";
import { useAppBootstrap } from "./use-app-bootstrap";

describe("useAppBootstrap — QueryClient rebuild on transport switch", () => {
	beforeEach(() => {
		localStorage.clear();
		// `createHelmorQueryClient` replaces React Query's focus listener with one
		// that dynamically `import("@tauri-apps/api/event")`s and attaches Tauri
		// focus/blur listeners. Under jsdom that dynamic import reaches into absent
		// Tauri internals and rejects asynchronously AFTER the test window, which
		// vitest flags as an unhandled rejection. Stub the registration to a no-op
		// so the dynamic import never runs — irrelevant to what this file asserts
		// (the QueryClient identity across transport generations).
		vi.spyOn(focusManager, "setEventListener").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("recreates the QueryClient when the transport generation bumps", () => {
		const { result } = renderHook(() => useAppBootstrap());
		const firstClient = result.current.queryClient;
		const firstGen = result.current.transportGeneration;
		expect(firstClient).toBeDefined();

		act(() => {
			bumpTransportGeneration();
		});

		// A new generation → a brand-new client (fresh, empty cache) so no
		// cross-backend data can bleed through.
		expect(result.current.transportGeneration).toBe(firstGen + 1);
		expect(result.current.queryClient).not.toBe(firstClient);
	});

	it("keeps the same QueryClient across unrelated re-renders", () => {
		const { result, rerender } = renderHook(() => useAppBootstrap());
		const client = result.current.queryClient;

		rerender();
		rerender();

		// No generation bump → identity-stable client (no cache thrash).
		expect(result.current.queryClient).toBe(client);
	});
});
