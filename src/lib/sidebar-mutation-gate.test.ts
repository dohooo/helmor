import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	beginSidebarMutation,
	createScopedSidebarGate,
	endSidebarMutation,
	holdSidebarMutation,
	isSidebarMutationInFlight,
	requestSidebarReconcile,
	resetSidebarMutationGate,
} from "./sidebar-mutation-gate";

describe("sidebar-mutation-gate", () => {
	let queryClient: QueryClient;
	let invalidateSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		resetSidebarMutationGate();
		queryClient = new QueryClient();
		invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
	});

	afterEach(() => {
		resetSidebarMutationGate();
	});

	describe("counter mechanics", () => {
		it("starts with no mutation in flight", () => {
			expect(isSidebarMutationInFlight()).toBe(false);
		});

		it("tracks nested begin/end pairs", () => {
			beginSidebarMutation();
			expect(isSidebarMutationInFlight()).toBe(true);
			beginSidebarMutation();
			expect(isSidebarMutationInFlight()).toBe(true);
			endSidebarMutation();
			expect(isSidebarMutationInFlight()).toBe(true);
			endSidebarMutation();
			expect(isSidebarMutationInFlight()).toBe(false);
		});

		it("clamps counter at zero on excess end calls", () => {
			endSidebarMutation();
			endSidebarMutation();
			expect(isSidebarMutationInFlight()).toBe(false);
			beginSidebarMutation();
			expect(isSidebarMutationInFlight()).toBe(true);
		});

		it("resetSidebarMutationGate zeroes the counter even mid-flight", () => {
			beginSidebarMutation();
			beginSidebarMutation();
			expect(isSidebarMutationInFlight()).toBe(true);
			resetSidebarMutationGate();
			expect(isSidebarMutationInFlight()).toBe(false);
		});
	});

	describe("endSidebarMutation auto-reconcile", () => {
		it("with queryClient + counter reaches 0 → reconciles", () => {
			beginSidebarMutation();
			endSidebarMutation(queryClient);
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("without queryClient → no reconcile (legacy shape during migration)", () => {
			beginSidebarMutation();
			endSidebarMutation();
			expect(invalidateSpy).not.toHaveBeenCalled();
		});

		it("with queryClient + counter still >0 → no reconcile (waits for outer release)", () => {
			beginSidebarMutation();
			beginSidebarMutation();
			endSidebarMutation(queryClient);
			expect(invalidateSpy).not.toHaveBeenCalled();
			endSidebarMutation(queryClient);
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("excess end with queryClient still triggers a single reconcile pass", () => {
			endSidebarMutation(queryClient);
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe("requestSidebarReconcile (gated invalidate for non-owner callers)", () => {
		it("invalidates when counter is 0", () => {
			requestSidebarReconcile(queryClient);
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("skips invalidate while a mutation is in flight", () => {
			beginSidebarMutation();
			requestSidebarReconcile(queryClient);
			expect(invalidateSpy).not.toHaveBeenCalled();
		});

		it("resumes reconciling once the gate is released", () => {
			beginSidebarMutation();
			requestSidebarReconcile(queryClient);
			expect(invalidateSpy).not.toHaveBeenCalled();
			endSidebarMutation(queryClient);
			// `endSidebarMutation` itself reconciles; a follow-up
			// reconcile request still passes through cleanly.
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
			requestSidebarReconcile(queryClient);
			expect(invalidateSpy).toHaveBeenCalledTimes(4);
		});

		it("never reconciles during nested mutations even when outer releases", () => {
			beginSidebarMutation();
			beginSidebarMutation();
			requestSidebarReconcile(queryClient);
			expect(invalidateSpy).not.toHaveBeenCalled();
			endSidebarMutation(queryClient);
			requestSidebarReconcile(queryClient);
			expect(invalidateSpy).not.toHaveBeenCalled();
			endSidebarMutation(queryClient);
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe("holdSidebarMutation (disposable helper)", () => {
		it("acquires on call and releases via the returned fn", () => {
			const release = holdSidebarMutation(queryClient);
			expect(isSidebarMutationInFlight()).toBe(true);
			release();
			expect(isSidebarMutationInFlight()).toBe(false);
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("release is idempotent — double-call decrements only once", () => {
			beginSidebarMutation(); // outer
			const release = holdSidebarMutation(queryClient);
			expect(isSidebarMutationInFlight()).toBe(true);
			release();
			expect(isSidebarMutationInFlight()).toBe(true); // outer still holding
			release(); // no-op — must not drop outer's hold
			expect(isSidebarMutationInFlight()).toBe(true);
			endSidebarMutation(queryClient);
			expect(isSidebarMutationInFlight()).toBe(false);
		});

		it("works correctly in try/finally with throw", () => {
			expect(() => {
				const release = holdSidebarMutation(queryClient);
				try {
					throw new Error("boom");
				} finally {
					release();
				}
			}).toThrow("boom");
			expect(isSidebarMutationInFlight()).toBe(false);
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("nested holds reconcile only after all are released", () => {
			const releaseOuter = holdSidebarMutation(queryClient);
			const releaseInner = holdSidebarMutation(queryClient);
			releaseInner();
			expect(invalidateSpy).not.toHaveBeenCalled();
			releaseOuter();
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe("createScopedSidebarGate (per-id, idempotent)", () => {
		it("begin(id) increments once per id; duplicate begin is a no-op", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.begin("a");
			expect(isSidebarMutationInFlight()).toBe(true);
			gate.begin("a"); // duplicate — no double-increment
			gate.end("a");
			expect(isSidebarMutationInFlight()).toBe(false);
		});

		it("end(id) without prior begin is a no-op (handles duplicate events)", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.end("a"); // no prior begin
			expect(isSidebarMutationInFlight()).toBe(false);
			expect(invalidateSpy).not.toHaveBeenCalled();
		});

		it("tracks distinct ids independently", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.begin("a");
			gate.begin("b");
			gate.begin("c");
			expect(isSidebarMutationInFlight()).toBe(true);
			gate.end("a");
			gate.end("b");
			expect(isSidebarMutationInFlight()).toBe(true);
			gate.end("c");
			expect(isSidebarMutationInFlight()).toBe(false);
		});

		it("reconciles only when last scoped id releases", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.begin("a");
			gate.begin("b");
			gate.end("a");
			expect(invalidateSpy).not.toHaveBeenCalled();
			gate.end("b");
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("interleaves correctly with plain holdSidebarMutation", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.begin("archive-1");
			const release = holdSidebarMutation(queryClient);
			gate.end("archive-1");
			expect(invalidateSpy).not.toHaveBeenCalled();
			release();
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("multiple gate instances share the same global counter", () => {
			const gateA = createScopedSidebarGate(queryClient);
			const gateB = createScopedSidebarGate(queryClient);
			gateA.begin("x");
			gateB.begin("y");
			expect(isSidebarMutationInFlight()).toBe(true);
			gateA.end("x");
			expect(isSidebarMutationInFlight()).toBe(true);
			gateB.end("y");
			expect(isSidebarMutationInFlight()).toBe(false);
		});

		it("disposeAll releases every outstanding hold (covers component unmount mid-flight)", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.begin("a");
			gate.begin("b");
			gate.begin("c");
			expect(isSidebarMutationInFlight()).toBe(true);
			gate.disposeAll();
			expect(isSidebarMutationInFlight()).toBe(false);
			// Reconcile runs exactly once when the last hold drops.
			expect(invalidateSpy).toHaveBeenCalledTimes(2);
		});

		it("disposeAll while no holds outstanding is a no-op", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.disposeAll();
			expect(isSidebarMutationInFlight()).toBe(false);
			expect(invalidateSpy).not.toHaveBeenCalled();
		});

		it("methods become no-ops after disposeAll (gate is unusable)", () => {
			const gate = createScopedSidebarGate(queryClient);
			gate.begin("a");
			gate.disposeAll();
			expect(isSidebarMutationInFlight()).toBe(false);
			// Late begin/end events (e.g. a backend success arriving
			// after the owner is gone) must not touch the counter.
			gate.begin("a");
			gate.end("a");
			gate.begin("late");
			expect(isSidebarMutationInFlight()).toBe(false);
		});

		it("disposeAll does not affect other gate instances' counters", () => {
			const gateA = createScopedSidebarGate(queryClient);
			const gateB = createScopedSidebarGate(queryClient);
			gateA.begin("a");
			gateB.begin("b");
			gateA.disposeAll();
			// B's hold is still live.
			expect(isSidebarMutationInFlight()).toBe(true);
			gateB.end("b");
			expect(isSidebarMutationInFlight()).toBe(false);
		});
	});
});
