import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateCssColorCache, resolveCssColor } from "./css-color";

// jsdom doesn't actually resolve var() through Canvas, so we don't assert
// the literal hex result. The behavioural contract we DO care about here:
//   1. Repeated lookups go through Canvas at most once per cache generation.
//   2. Alpha overrides bucket independently.
//   3. invalidateCssColorCache() reopens the path for the next lookup.

describe("resolveCssColor cache", () => {
	beforeEach(() => {
		invalidateCssColorCache();
	});

	it("caches repeated lookups within a generation", () => {
		const spy = vi.spyOn(window, "getComputedStyle");
		resolveCssColor("rgb(10, 20, 30)");
		resolveCssColor("rgb(10, 20, 30)");
		resolveCssColor("rgb(10, 20, 30)");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("distinguishes alpha overrides in the cache", () => {
		const spy = vi.spyOn(window, "getComputedStyle");
		resolveCssColor("rgb(10, 20, 30)");
		resolveCssColor("rgb(10, 20, 30)", 0.5);
		resolveCssColor("rgb(10, 20, 30)");
		resolveCssColor("rgb(10, 20, 30)", 0.5);
		// Two distinct cache keys → two computeStyle calls.
		expect(spy).toHaveBeenCalledTimes(2);
		spy.mockRestore();
	});

	it("re-runs the resolver after invalidateCssColorCache", () => {
		const spy = vi.spyOn(window, "getComputedStyle");
		resolveCssColor("rgb(10, 20, 30)");
		expect(spy).toHaveBeenCalledTimes(1);
		resolveCssColor("rgb(10, 20, 30)");
		expect(spy).toHaveBeenCalledTimes(1);
		invalidateCssColorCache();
		resolveCssColor("rgb(10, 20, 30)");
		expect(spy).toHaveBeenCalledTimes(2);
		spy.mockRestore();
	});
});
