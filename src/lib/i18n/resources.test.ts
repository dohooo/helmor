import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

// Guards against the failure mode the old "English-as-key" system had: a string
// that exists in one locale but not the other silently falls back to English.
describe("i18n catalogs", () => {
	const enKeys = Object.keys(en).sort();
	const zhKeys = Object.keys(zhCN).sort();

	it("en and zh-CN have identical key sets", () => {
		const missingInZh = enKeys.filter((k) => !(k in zhCN));
		const missingInEn = zhKeys.filter((k) => !(k in en));
		expect(missingInZh, "keys present in en but missing in zh-CN").toEqual([]);
		expect(missingInEn, "keys present in zh-CN but missing in en").toEqual([]);
	});

	it("has no empty translations", () => {
		const emptyEn = enKeys.filter((k) => !(en as Record<string, string>)[k]);
		const emptyZh = zhKeys.filter((k) => !(zhCN as Record<string, string>)[k]);
		expect(emptyEn, "empty english values").toEqual([]);
		expect(emptyZh, "empty chinese values").toEqual([]);
	});
});
