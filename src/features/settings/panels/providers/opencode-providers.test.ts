import { describe, expect, it } from "vitest";
import { PROVIDER_BRAND_ICONS } from "@/components/icons";
import type { OpencodeCachedModel } from "@/lib/settings";
import catalog from "@/shared/provider-catalog.json";
import {
	findOpencodePreset,
	OPENCODE_PROVIDER_PRESETS,
} from "./builtin-opencode-providers";
import { groupHeading } from "./model-multi-select";
import { customSig, generateProviderId } from "./opencode-custom-providers";
import { defaultEnabledSlugs } from "./opencode-models";

describe("customSig", () => {
	const base = {
		id: "my-proxy",
		name: "My Proxy",
		baseUrl: "https://example.com/v1",
		apiKey: "sk-1",
		headers: {},
		models: [{ id: "m1", name: "Model One", reasoning: true }],
	};

	it("ignores surrounding whitespace and empty-id models", () => {
		const padded = {
			...base,
			id: "  my-proxy  ",
			name: "My Proxy ",
			models: [
				{ id: " m1 ", name: "Model One", reasoning: true },
				{ id: "", name: "dropped", reasoning: false },
			],
		};
		expect(customSig(padded)).toBe(customSig(base));
	});

	it("changes when any meaningful field changes", () => {
		expect(customSig({ ...base, apiKey: "sk-2" })).not.toBe(customSig(base));
		expect(customSig({ ...base, baseUrl: "https://other/v1" })).not.toBe(
			customSig(base),
		);
		expect(
			customSig({
				...base,
				models: [{ id: "m1", name: "Model One", reasoning: false }],
			}),
		).not.toBe(customSig(base));
	});
});

describe("generateProviderId", () => {
	it("slugifies the display name", () => {
		expect(generateProviderId("My Proxy", "", new Set())).toBe("my-proxy");
	});

	it("appends a numeric suffix to avoid clashing with custom blocks or presets", () => {
		expect(generateProviderId("DeepSeek", "", new Set(["deepseek"]))).toBe(
			"deepseek-2",
		);
		expect(
			generateProviderId("My Proxy", "", new Set(["my-proxy", "my-proxy-2"])),
		).toBe("my-proxy-3");
	});

	it("falls back to the base URL host, then 'custom'", () => {
		expect(
			generateProviderId("", "https://api.example.com/v1", new Set()),
		).toBe("api-example-com");
		expect(generateProviderId("", "api.example.com/v1", new Set())).toBe(
			"api-example-com",
		);
		expect(generateProviderId("", "not a url", new Set())).toBe("custom");
	});
});

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

	it("prefers the OpenCode Zen subset for a large catalog", () => {
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

	it("falls back to the first 12 when a large catalog has no Zen models", () => {
		const big = models(Array.from({ length: 20 }, (_, i) => `vendor/m${i}`));
		expect(defaultEnabledSlugs(big)).toEqual(
			Array.from({ length: 12 }, (_, i) => `vendor/m${i}`),
		);
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
