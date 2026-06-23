import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import en from "./locales/en.json";

// Guards the core failure mode of a key-based i18n system: a `t()` / `<I18nText
// source>` call that references a key missing from the catalog (would render the
// raw key string). SourceIcon's `source` prop is an icon id, not a catalog key.
const I18N_CALLS = new Set([
	"t",
	"f",
	"translateSource",
	"formatSource",
	"translateSourceMaybe",
]);
const NON_I18N_SOURCE_TAGS = new Set(["SourceIcon"]);

function usedKeys(): { key: string; loc: string }[] {
	const out: { key: string; loc: string }[] = [];
	const files = execSync("git ls-files 'src/**/*.tsx' 'src/**/*.ts'")
		.toString()
		.trim()
		.split("\n")
		.filter(
			(f) =>
				f &&
				!f.includes(".test.") &&
				!f.startsWith("src/lib/i18n/") &&
				!f.includes("/mockup/"),
		);
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		const sf = ts.createSourceFile(
			file,
			src,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);
		const visit = (n: ts.Node) => {
			if (ts.isCallExpression(n)) {
				const fn = n.expression;
				const name = ts.isIdentifier(fn)
					? fn.text
					: ts.isPropertyAccessExpression(fn)
						? fn.name.text
						: "";
				if (I18N_CALLS.has(name)) {
					const a = n.arguments[0];
					if (a && ts.isStringLiteral(a)) out.push({ key: a.text, loc: file });
				}
			}
			if (
				ts.isJsxAttribute(n) &&
				n.name.getText() === "source" &&
				n.initializer
			) {
				const parent = (n.parent?.parent as ts.JsxOpeningLikeElement)?.tagName;
				const tag = parent ? parent.getText() : "";
				if (!NON_I18N_SOURCE_TAGS.has(tag)) {
					const i = n.initializer;
					const lit = ts.isStringLiteral(i)
						? i
						: ts.isJsxExpression(i) &&
								i.expression &&
								ts.isStringLiteral(i.expression)
							? i.expression
							: null;
					if (lit) out.push({ key: lit.text, loc: file });
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return out;
}

describe("i18n keys referenced in code", () => {
	it("all literal t()/I18nText keys exist in the catalog", () => {
		const catalog = en as Record<string, string>;
		const missing = usedKeys()
			.filter(({ key }) => !(key in catalog))
			.map(({ key, loc }) => `${key} @ ${loc}`);
		expect(missing).toEqual([]);
	});
});
