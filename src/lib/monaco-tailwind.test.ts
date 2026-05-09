import { describe, expect, it } from "vitest";
import { __testing__ } from "./monaco-tailwind";
import { resolveTailwindCss } from "./monaco-tailwind-css";

const { SEED_CLASSES, harvestFromText, repoClasses } = __testing__;

describe("seed list", () => {
	it("covers common utility shapes for v3 and v4 default vocabularies", () => {
		const seed = new Set(SEED_CLASSES);
		for (const expected of [
			"flex",
			"grid",
			"hidden",
			"p-4",
			"-mt-2",
			"px-px",
			"w-1/2",
			"w-full",
			"h-screen",
			"text-sm",
			"font-semibold",
			"bg-blue-500",
			"text-zinc-900",
			"border-red-200",
			"rounded-md",
			"rounded-tr-lg",
			"ring-2",
			"shadow-lg",
			"opacity-50",
			"cursor-pointer",
			"grid-cols-12",
			"col-span-3",
			"transition-colors",
			"duration-200",
			"animate-pulse",
		]) {
			expect(seed.has(expected), `missing seed entry: ${expected}`).toBe(true);
		}
	});
});

describe("harvestFromText", () => {
	it("extracts class names from className/class attributes", () => {
		repoClasses.clear();
		harvestFromText(
			`<div className="custom-x my-special-class hover:bg-foo/40 w-[42px]"/>`,
		);
		expect(repoClasses.has("custom-x")).toBe(true);
		expect(repoClasses.has("my-special-class")).toBe(true);
		expect(repoClasses.has("hover:bg-foo/40")).toBe(true);
		expect(repoClasses.has("w-[42px]")).toBe(true);
	});

	it("extracts class names from @apply directives", () => {
		repoClasses.clear();
		harvestFromText(`.btn { @apply rounded-2xl bg-brand-500 text-on-brand; }`);
		expect(repoClasses.has("rounded-2xl")).toBe(true);
		expect(repoClasses.has("bg-brand-500")).toBe(true);
		expect(repoClasses.has("text-on-brand")).toBe(true);
	});

	it("extracts class names from cn/clsx call arguments", () => {
		repoClasses.clear();
		harvestFromText(
			`const c = cn("foo-1 bar-2", { "active-thing": isActive }, clsx("baz-3"));`,
		);
		expect(repoClasses.has("foo-1")).toBe(true);
		expect(repoClasses.has("bar-2")).toBe(true);
		expect(repoClasses.has("baz-3")).toBe(true);
	});

	it("rejects shapes that aren't valid class tokens", () => {
		repoClasses.clear();
		harvestFromText(`<div className="flex TRUE 12345 has space"/>`);
		expect(repoClasses.has("flex")).toBe(true);
		expect(repoClasses.has("TRUE")).toBe(false);
		expect(repoClasses.has("12345")).toBe(false);
		expect(repoClasses.has("has space")).toBe(false);
	});

	it("skips files larger than the harvest cap", () => {
		repoClasses.clear();
		const huge = `<div className="never-seen">${"x".repeat(300_000)}</div>`;
		harvestFromText(huge);
		expect(repoClasses.has("never-seen")).toBe(false);
	});
});

describe("isInsideClassValue", () => {
	const { isInsideClassValue } = __testing__;

	function makeModel(text: string) {
		const lines = text.split("\n");
		return {
			getLineContent(line: number) {
				return lines[line - 1] ?? "";
			},
		} as unknown as import("monaco-editor").editor.ITextModel;
	}

	it('returns true inside an unclosed className="..."', () => {
		const text = `<div className="flex items-`;
		const model = makeModel(text);
		const position = {
			lineNumber: 1,
			column: text.length + 1,
		} as unknown as import("monaco-editor").Position;
		expect(isInsideClassValue(model, position)).toBe(true);
	});

	it("returns false after the className value closes", () => {
		const text = `<div className="flex" id="`;
		const model = makeModel(text);
		const position = {
			lineNumber: 1,
			column: text.length + 1,
		} as unknown as import("monaco-editor").Position;
		expect(isInsideClassValue(model, position)).toBe(false);
	});

	it('returns true inside a cn("...") string argument', () => {
		const text = `cn("flex items-`;
		const model = makeModel(text);
		const position = {
			lineNumber: 1,
			column: text.length + 1,
		} as unknown as import("monaco-editor").Position;
		expect(isInsideClassValue(model, position)).toBe(true);
	});
});

describe("resolveTailwindCss", () => {
	it("resolves spacing utilities formulaically", () => {
		expect(resolveTailwindCss("px-1")?.css).toBe(
			"padding-left: 0.25rem;\npadding-right: 0.25rem;",
		);
		expect(resolveTailwindCss("p-4")?.css).toBe("padding: 1rem;");
		expect(resolveTailwindCss("mt-0.5")?.css).toBe("margin-top: 0.125rem;");
		expect(resolveTailwindCss("-mx-2")?.css).toBe(
			"margin-left: -0.5rem;\nmargin-right: -0.5rem;",
		);
		expect(resolveTailwindCss("gap-px")?.css).toBe("gap: 1px;");
	});

	it("resolves sizing including fractions and screen", () => {
		expect(resolveTailwindCss("w-1/2")?.css).toBe("width: 50%;");
		expect(resolveTailwindCss("w-full")?.css).toBe("width: 100%;");
		expect(resolveTailwindCss("h-screen")?.css).toBe("height: 100vh;");
		expect(resolveTailwindCss("max-w-prose")?.css).toBe("max-width: 65ch;");
	});

	it("resolves typography, radius, opacity, z-index", () => {
		expect(resolveTailwindCss("text-sm")?.css).toBe(
			"font-size: 0.875rem;\nline-height: 1.25rem;",
		);
		expect(resolveTailwindCss("font-semibold")?.css).toBe("font-weight: 600;");
		expect(resolveTailwindCss("rounded-md")?.css).toBe(
			"border-radius: 0.375rem;",
		);
		expect(resolveTailwindCss("opacity-50")?.css).toBe("opacity: 0.5;");
		expect(resolveTailwindCss("z-10")?.css).toBe("z-index: 10;");
	});

	it("resolves colors with hex preview metadata", () => {
		const blue500 = resolveTailwindCss("bg-blue-500");
		expect(blue500?.css).toBe("background-color: #3b82f6;");
		expect(blue500?.colorHex).toBe("#3b82f6");

		expect(resolveTailwindCss("text-white")?.css).toBe("color: #fff;");
		expect(resolveTailwindCss("border-transparent")?.css).toBe(
			"border-color: transparent;",
		);
	});

	it("strips variant prefixes before resolving", () => {
		expect(resolveTailwindCss("hover:bg-red-500")?.css).toBe(
			"background-color: #ef4444;",
		);
		expect(resolveTailwindCss("dark:lg:text-white")?.css).toBe("color: #fff;");
	});

	it("returns null for unknown / arbitrary values", () => {
		expect(resolveTailwindCss("w-[42px]")).toBeNull();
		expect(resolveTailwindCss("totally-custom")).toBeNull();
		expect(resolveTailwindCss("bg-mystery-500")).toBeNull();
	});
});
