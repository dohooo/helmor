import { describe, expect, it } from "vitest";
import { PROVIDER_BRAND_ICONS } from "@/components/icons";
import type { OpencodeCachedModel } from "@/lib/settings";
import catalog from "@/shared/provider-catalog.json";
import {
	findMimoPreset,
	MIMO_PROVIDER_PRESETS,
} from "./builtin-mimo-providers";
import {
	findOpencodePreset,
	OPENCODE_PROVIDER_PRESETS,
} from "./builtin-opencode-providers";
import { groupHeading } from "./model-multi-select";
import {
	defaultEnabledSlugs,
	isMimoBuiltinProvider,
	reconcileEnabledModelIds,
} from "./opencode-model-defaults";

describe("findOpencodePreset", () => {
	it("finds a known preset by key and returns undefined otherwise", () => {
		expect(findOpencodePreset("deepseek")?.key).toBe("deepseek");
		expect(findOpencodePreset("not-a-provider")).toBeUndefined();
	});
});

describe("defaultEnabledSlugs", () => {
	const models = (slugs: string[]): OpencodeCachedModel[] =>
		slugs.map((slug) => ({ slug, label: slug }));

	it("enables every model for a small catalog (≤12)", () => {
		const small = models(["a/1", "a/2", "b/3"]);
		expect(defaultEnabledSlugs(small)).toEqual(["a/1", "a/2", "b/3"]);
	});

	it("trims env-injected bulk to Zen for a large catalog (no configured providers)", () => {
		const big = models([
			...Array.from({ length: 15 }, (_, i) => `vendor/m${i}`),
			"opencode/zen-a",
			"opencode/zen-b",
		]);
		expect(defaultEnabledSlugs(big)).toEqual([
			"opencode/zen-a",
			"opencode/zen-b",
		]);
	});

	it("keeps configured custom providers (+ Zen) in a large catalog", () => {
		const big = models([
			...Array.from({ length: 15 }, (_, i) => `vendor/m${i}`), // env bulk → trimmed
			"opencode/zen-a",
			"hundun/deepseek",
			"hundun/chat",
		]);
		expect(defaultEnabledSlugs(big, new Set(["hundun"]))).toEqual([
			"opencode/zen-a",
			"hundun/deepseek",
			"hundun/chat",
		]);
	});

	it("falls back to the first 12 when a large catalog has no Zen models", () => {
		const big = models(Array.from({ length: 20 }, (_, i) => `vendor/m${i}`));
		expect(defaultEnabledSlugs(big)).toEqual(
			Array.from({ length: 12 }, (_, i) => `vendor/m${i}`),
		);
	});
});

describe("reconcileEnabledModelIds", () => {
	const models = (slugs: string[]): OpencodeCachedModel[] =>
		slugs.map((slug) => ({ slug, label: slug }));

	it("auto-picks defaults on first fetch (prev null)", () => {
		const cached = models(["a/1", "a/2"]);
		expect(reconcileEnabledModelIds(null, cached, null)).toEqual([
			"a/1",
			"a/2",
		]);
	});

	it("respects an explicit empty list (user cleared all)", () => {
		const cached = models(["a/1", "a/2"]);
		expect(reconcileEnabledModelIds([], cached, models(["a/1"]))).toEqual([]);
	});

	it("auto-enables newly-appeared models from a just-added custom provider", () => {
		// prev picks + prev cache = the zen models; refresh adds 2 custom models.
		const prev = ["opencode/a", "opencode/b"];
		const prevCache = models(["opencode/a", "opencode/b"]);
		const cached = models([
			"opencode/a",
			"opencode/b",
			"hundun/deepseek",
			"hundun/chat",
		]);
		expect(
			reconcileEnabledModelIds(prev, cached, prevCache, new Set(["hundun"])),
		).toEqual(["opencode/a", "opencode/b", "hundun/deepseek", "hundun/chat"]);
	});

	it("does NOT auto-enable newly-appeared env-bulk (unconfigured) models", () => {
		const prev = ["opencode/a"];
		const prevCache = models(["opencode/a"]);
		const cached = models(["opencode/a", "openai/gpt-x", "anthropic/claude-y"]);
		// New models belong to providers the user never configured → stay off.
		expect(
			reconcileEnabledModelIds(prev, cached, prevCache, new Set()),
		).toEqual(["opencode/a"]);
	});

	it("keeps user picks when nothing new appeared", () => {
		const prev = ["opencode/a"];
		const cache = models(["opencode/a", "opencode/b"]);
		// prev cache already had both → b was deliberately left disabled, keep it off.
		expect(reconcileEnabledModelIds(prev, cache, cache)).toEqual([
			"opencode/a",
		]);
	});

	it("falls back to defaults when every prior pick went stale", () => {
		const prev = ["old/x"];
		const cached = models(["a/1", "a/2"]);
		expect(reconcileEnabledModelIds(prev, cached, models(["old/x"]))).toEqual([
			"a/1",
			"a/2",
		]);
	});
});

describe("mimo model defaults (isMimoBuiltinProvider)", () => {
	const models = (slugs: string[]): OpencodeCachedModel[] =>
		slugs.map((slug) => ({ slug, label: slug }));

	it("treats xiaomi, mimo, and xiaomi-token-plan* as intentional built-ins", () => {
		expect(isMimoBuiltinProvider("xiaomi")).toBe(true);
		expect(isMimoBuiltinProvider("mimo")).toBe(true);
		expect(isMimoBuiltinProvider("xiaomi-token-plan")).toBe(true);
		expect(isMimoBuiltinProvider("xiaomi-token-plan-pro")).toBe(true);
		expect(isMimoBuiltinProvider("opencode")).toBe(false);
		expect(isMimoBuiltinProvider("openai")).toBe(false);
	});

	it("keeps mimo built-ins (+ configured providers) in a large catalog", () => {
		const big = models([
			...Array.from({ length: 15 }, (_, i) => `vendor/m${i}`), // env bulk → trimmed
			"xiaomi/mimo-1",
			"xiaomi-token-plan-pro/mimo-2",
			"hundun/deepseek",
		]);
		expect(
			defaultEnabledSlugs(big, new Set(["hundun"]), isMimoBuiltinProvider),
		).toEqual([
			"xiaomi/mimo-1",
			"xiaomi-token-plan-pro/mimo-2",
			"hundun/deepseek",
		]);
	});

	it("auto-enables newly-appeared xiaomi models on refresh", () => {
		const prev = ["xiaomi/mimo-1"];
		const prevCache = models(["xiaomi/mimo-1"]);
		const cached = models(["xiaomi/mimo-1", "xiaomi/mimo-2", "openai/gpt-x"]);
		expect(
			reconcileEnabledModelIds(
				prev,
				cached,
				prevCache,
				new Set(),
				isMimoBuiltinProvider,
			),
		).toEqual(["xiaomi/mimo-1", "xiaomi/mimo-2"]);
	});
});

describe("groupHeading", () => {
	it("uses the label prefix before ' · ' as the sub-provider heading", () => {
		expect(
			groupHeading({
				id: "hundun/deepseek-v4",
				label: "DeepSeek (Hundun) · V4",
			}),
		).toBe("DeepSeek (Hundun)");
	});

	it("falls back to the slug's provider id when the label has no separator", () => {
		expect(
			groupHeading({ id: "opencode/big-pickle", label: "Big Pickle" }),
		).toBe("opencode");
	});
});

describe("provider catalog", () => {
	const validKeys = new Set(Object.keys(PROVIDER_BRAND_ICONS));
	const groups: Array<{ key: string; icon: string }>[] = [
		catalog.claude as Array<{ key: string; icon: string }>,
		catalog.opencode as Array<{ key: string; icon: string }>,
		catalog.mimo as Array<{ key: string; icon: string }>,
	];

	it("every catalog icon resolves to a registered brand icon (no silent Box fallback)", () => {
		for (const group of groups) {
			for (const provider of group) {
				expect(
					provider.icon === "generic" || validKeys.has(provider.icon),
					`${provider.key} → icon "${provider.icon}" is not registered`,
				).toBe(true);
			}
		}
	});

	it("has no duplicate provider keys within a catalog group", () => {
		for (const group of groups) {
			const keys = group.map((p) => p.key);
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	it("every opencode preset is discoverable via findOpencodePreset", () => {
		for (const preset of OPENCODE_PROVIDER_PRESETS) {
			expect(findOpencodePreset(preset.key)).toBe(preset);
		}
	});

	it("composes the mimo presets as Xiaomi first, then every opencode preset", () => {
		expect(MIMO_PROVIDER_PRESETS[0]?.key).toBe("xiaomi");
		const mimoSpecific = MIMO_PROVIDER_PRESETS.slice(
			0,
			MIMO_PROVIDER_PRESETS.length - OPENCODE_PROVIDER_PRESETS.length,
		);
		expect(mimoSpecific).toEqual(catalog.mimo);
		expect(MIMO_PROVIDER_PRESETS.slice(mimoSpecific.length)).toEqual([
			...OPENCODE_PROVIDER_PRESETS,
		]);
		// Composition must not introduce duplicate keys.
		const keys = MIMO_PROVIDER_PRESETS.map((p) => p.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("every mimo preset is discoverable via findMimoPreset", () => {
		for (const preset of MIMO_PROVIDER_PRESETS) {
			expect(findMimoPreset(preset.key)).toBe(preset);
		}
		expect(findMimoPreset("not-a-provider")).toBeUndefined();
	});

	// Dropdown renders catalog order directly: same-icon presets must stay contiguous, generic-icon ones last.
	it("keeps same-icon opencode presets contiguous, generic-icon ones last", () => {
		const icons = (catalog.opencode as Array<{ icon: string }>).map(
			(p) => p.icon,
		);
		const seen = new Set<string>();
		let sawGeneric = false;
		for (const icon of icons) {
			if (icon === "generic") {
				sawGeneric = true;
				continue;
			}
			expect(sawGeneric).toBe(false);
			const last = [...seen].at(-1);
			if (icon !== last) {
				expect(seen.has(icon)).toBe(false);
				seen.add(icon);
			}
		}
	});
});
