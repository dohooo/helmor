import { describe, expect, it } from "vitest";
import type { KimiCachedModel } from "@/lib/settings";
import { findKimiPreset, KIMI_CATALOG_PRESETS } from "./builtin-kimi-providers";
import { deriveProviderId, hostFromUrl, slugify } from "./kimi-provider-id";
import { reconcileKimiEnabledModelIds } from "./use-kimi-model-sync";

describe("slugify", () => {
	it("lowercases and collapses non-alphanumerics into dashes", () => {
		expect(slugify("My Proxy!")).toBe("my-proxy");
		expect(slugify("  Hundun  AI  ")).toBe("hundun-ai");
	});

	it("truncates to 32 chars without a trailing dash", () => {
		expect(slugify(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
	});

	it("returns empty for input with no usable characters", () => {
		expect(slugify("!!!")).toBe("");
	});
});

describe("hostFromUrl", () => {
	it("extracts the hostname, retrying with an https:// prefix", () => {
		expect(hostFromUrl("https://api.example.com/v1")).toBe("api.example.com");
		expect(hostFromUrl("api.example.com/v1")).toBe("api.example.com");
	});

	it("returns empty for garbage", () => {
		expect(hostFromUrl("not a url")).toBe("");
	});
});

describe("deriveProviderId", () => {
	it("slugifies the display name", () => {
		expect(deriveProviderId("My Proxy", "", new Set())).toBe("my-proxy");
	});

	it("falls back to the base URL host, then 'custom'", () => {
		expect(deriveProviderId("", "https://api.example.com/v1", new Set())).toBe(
			"api-example-com",
		);
		expect(deriveProviderId("", "not a url", new Set())).toBe("custom");
	});

	it("appends a numeric suffix to avoid clashing with existing providers", () => {
		expect(deriveProviderId("DeepSeek", "", new Set(["deepseek"]))).toBe(
			"deepseek-2",
		);
		expect(
			deriveProviderId("My Proxy", "", new Set(["my-proxy", "my-proxy-2"])),
		).toBe("my-proxy-3");
	});
});

describe("findKimiPreset", () => {
	it("finds a known preset by id and returns undefined otherwise", () => {
		expect(findKimiPreset("moonshotai")?.id).toBe("moonshotai");
		expect(findKimiPreset("not-a-provider")).toBeUndefined();
	});

	it("every preset is discoverable via findKimiPreset", () => {
		for (const preset of KIMI_CATALOG_PRESETS) {
			expect(findKimiPreset(preset.id)).toBe(preset);
		}
	});
});

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
