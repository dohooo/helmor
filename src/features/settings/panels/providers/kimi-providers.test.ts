import { describe, expect, it } from "vitest";
import type { KimiCachedModel } from "@/lib/settings";
import { reconcileKimiEnabledModelIds } from "./use-kimi-model-sync";

describe("reconcileKimiEnabledModelIds", () => {
	const models = (ids: string[]): KimiCachedModel[] =>
		ids.map((id) => ({ id, label: id }));

	it("enables every discovered model on first sync (prev null)", () => {
		expect(
			reconcileKimiEnabledModelIds(null, models(["a", "b"]), null),
		).toEqual(["a", "b"]);
	});

	it("preserves user deselections on later syncs", () => {
		const cache = models(["a", "b"]);
		// prev cache already had b → it was deliberately left disabled, keep it off.
		expect(reconcileKimiEnabledModelIds(["a"], cache, cache)).toEqual(["a"]);
	});

	it("auto-enables newly-discovered models from a just-added provider", () => {
		expect(
			reconcileKimiEnabledModelIds(
				["a"],
				models(["a", "b", "new-1", "new-2"]),
				models(["a", "b"]),
			),
		).toEqual(["a", "new-1", "new-2"]);
	});

	it("drops picks whose models disappeared", () => {
		expect(
			reconcileKimiEnabledModelIds(
				["a", "gone"],
				models(["a"]),
				models(["a", "gone"]),
			),
		).toEqual(["a"]);
	});
});
