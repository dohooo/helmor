import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLatestRef, useStableActions } from "./use-stable-actions";

describe("useLatestRef", () => {
	it("returns a ref whose current is the initial value", () => {
		const { result } = renderHook(({ value }) => useLatestRef(value), {
			initialProps: { value: 42 },
		});
		expect(result.current.current).toBe(42);
	});

	it("updates current on every render with the latest value", () => {
		const { result, rerender } = renderHook(
			({ value }) => useLatestRef(value),
			{
				initialProps: { value: 1 },
			},
		);
		rerender({ value: 2 });
		expect(result.current.current).toBe(2);
		rerender({ value: 99 });
		expect(result.current.current).toBe(99);
	});

	it("returns the same ref object across renders (stable identity)", () => {
		const { result, rerender } = renderHook(
			({ value }) => useLatestRef(value),
			{
				initialProps: { value: "a" },
			},
		);
		const first = result.current;
		rerender({ value: "b" });
		expect(result.current).toBe(first);
	});
});

describe("useStableActions", () => {
	it("forwards calls to the live closure", () => {
		const handler = vi.fn();
		const { result } = renderHook(
			({ h }: { h: () => void }) => useStableActions({ doIt: h }),
			{ initialProps: { h: handler } },
		);
		result.current.doIt();
		expect(handler).toHaveBeenCalledOnce();
	});

	it("returned object has stable identity across renders", () => {
		const { result, rerender } = renderHook(
			({ h }: { h: () => void }) => useStableActions({ doIt: h }),
			{ initialProps: { h: () => {} } },
		);
		const first = result.current;
		rerender({ h: () => {} });
		expect(result.current).toBe(first);
	});

	it("individual method identities are stable across renders", () => {
		const { result, rerender } = renderHook(
			({ h }: { h: () => void }) => useStableActions({ doIt: h }),
			{ initialProps: { h: () => {} } },
		);
		const firstMethod = result.current.doIt;
		rerender({ h: () => {} });
		expect(result.current.doIt).toBe(firstMethod);
	});

	it("calls always hit the latest closure (no stale captures)", () => {
		const first = vi.fn();
		const second = vi.fn();
		const { result, rerender } = renderHook(
			({ h }: { h: () => void }) => useStableActions({ doIt: h }),
			{ initialProps: { h: first } },
		);
		rerender({ h: second });
		result.current.doIt();
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});

	it("forwards arguments verbatim", () => {
		const handler = vi.fn();
		const { result } = renderHook(
			({ h }: { h: (a: number, b: string) => void }) =>
				useStableActions({ doIt: h }),
			{ initialProps: { h: handler } },
		);
		result.current.doIt(7, "hi");
		expect(handler).toHaveBeenCalledWith(7, "hi");
	});

	it("forwards return values (including Promises)", async () => {
		const handler = vi.fn().mockResolvedValue("ok");
		const { result } = renderHook(
			({ h }: { h: () => Promise<string> }) => useStableActions({ doIt: h }),
			{ initialProps: { h: handler } },
		);
		const got = await result.current.doIt();
		expect(got).toBe("ok");
	});

	it("supports multiple methods with distinct signatures", () => {
		const onA = vi.fn();
		const onB = vi.fn();
		const { result } = renderHook(() =>
			useStableActions({
				a: (x: number) => onA(x),
				b: (y: string, z: boolean) => onB(y, z),
			}),
		);
		result.current.a(1);
		result.current.b("hello", true);
		expect(onA).toHaveBeenCalledWith(1);
		expect(onB).toHaveBeenCalledWith("hello", true);
	});
});
