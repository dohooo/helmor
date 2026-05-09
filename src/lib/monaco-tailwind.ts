// Tailwind class-name completion for Monaco — pure provider, no worker.
//
// monaco-tailwindcss is unmaintained against monaco-editor 0.55+ (its
// monaco-worker-manager dep calls a removed createWebWorker shape). Rather
// than fork it, we register a plain CompletionItemProvider with two sources:
//
//   A) A generated static seed of Tailwind's default utility vocabulary
//      (colors × shades, spacing scale, sizing, typography, etc.). Covers v3
//      and v4 default classes — they overlap almost entirely.
//
//   B) A repo scan that harvests class names from every model the user opens
//      (className/class attributes, @apply directives, cn/clsx/cva args).
//      This catches v4 @theme tokens, v3 config extensions, and arbitrary
//      values like w-[42px] without running the Tailwind compiler.
//
// Trade-off vs. monaco-tailwindcss: no color decorators, no CSS hover
// previews, no diagnostics. Just completion — which is the 90% feature.

import type * as Monaco from "monaco-editor";
import { type ResolvedCss, resolveTailwindCss } from "./monaco-tailwind-css";

type MonacoModule = typeof Monaco;

// ── Seed list generation ────────────────────────────────────────────────────

const COLORS = [
	"slate",
	"gray",
	"zinc",
	"neutral",
	"stone",
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"emerald",
	"teal",
	"cyan",
	"sky",
	"blue",
	"indigo",
	"violet",
	"purple",
	"fuchsia",
	"pink",
	"rose",
];
const SHADES = [
	"50",
	"100",
	"200",
	"300",
	"400",
	"500",
	"600",
	"700",
	"800",
	"900",
	"950",
];
const SPECIAL_COLORS = ["transparent", "current", "inherit", "black", "white"];
const SPACING = [
	"0",
	"px",
	"0.5",
	"1",
	"1.5",
	"2",
	"2.5",
	"3",
	"3.5",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"10",
	"11",
	"12",
	"14",
	"16",
	"20",
	"24",
	"28",
	"32",
	"36",
	"40",
	"44",
	"48",
	"52",
	"56",
	"60",
	"64",
	"72",
	"80",
	"96",
];
const FRACTIONS = [
	"1/2",
	"1/3",
	"2/3",
	"1/4",
	"2/4",
	"3/4",
	"1/5",
	"2/5",
	"3/5",
	"4/5",
	"1/6",
	"5/6",
	"1/12",
	"11/12",
	"full",
	"auto",
	"min",
	"max",
	"fit",
];

function buildSeedClasses(): string[] {
	const out = new Set<string>();
	const add = (...classes: string[]) => {
		for (const c of classes) out.add(c);
	};

	// Layout / display
	add(
		"block",
		"inline-block",
		"inline",
		"flex",
		"inline-flex",
		"grid",
		"inline-grid",
		"contents",
		"hidden",
		"table",
		"table-row",
		"table-cell",
		"flow-root",
		"list-item",
	);
	add("absolute", "relative", "fixed", "sticky", "static");
	add(
		"flex-row",
		"flex-row-reverse",
		"flex-col",
		"flex-col-reverse",
		"flex-wrap",
		"flex-nowrap",
		"flex-wrap-reverse",
		"flex-1",
		"flex-auto",
		"flex-initial",
		"flex-none",
	);
	add("grow", "grow-0", "shrink", "shrink-0");
	add("basis-auto", "basis-full", "basis-0");
	add(
		"items-start",
		"items-end",
		"items-center",
		"items-baseline",
		"items-stretch",
	);
	add(
		"justify-start",
		"justify-end",
		"justify-center",
		"justify-between",
		"justify-around",
		"justify-evenly",
	);
	add(
		"self-start",
		"self-end",
		"self-center",
		"self-stretch",
		"self-auto",
		"self-baseline",
	);
	add(
		"content-start",
		"content-end",
		"content-center",
		"content-between",
		"content-around",
		"content-evenly",
	);
	add(
		"place-items-start",
		"place-items-end",
		"place-items-center",
		"place-items-stretch",
	);
	add(
		"place-content-start",
		"place-content-end",
		"place-content-center",
		"place-content-between",
		"place-content-around",
		"place-content-evenly",
		"place-content-stretch",
	);
	add(
		"place-self-auto",
		"place-self-start",
		"place-self-end",
		"place-self-center",
		"place-self-stretch",
	);

	// Typography
	add("text-left", "text-center", "text-right", "text-justify");
	add("text-start", "text-end");
	add(
		"text-xs",
		"text-sm",
		"text-base",
		"text-lg",
		"text-xl",
		"text-2xl",
		"text-3xl",
		"text-4xl",
		"text-5xl",
		"text-6xl",
		"text-7xl",
		"text-8xl",
		"text-9xl",
	);
	add(
		"font-thin",
		"font-extralight",
		"font-light",
		"font-normal",
		"font-medium",
		"font-semibold",
		"font-bold",
		"font-extrabold",
		"font-black",
	);
	add("font-sans", "font-serif", "font-mono");
	add(
		"italic",
		"not-italic",
		"underline",
		"line-through",
		"no-underline",
		"overline",
		"uppercase",
		"lowercase",
		"capitalize",
		"normal-case",
	);
	add(
		"tracking-tighter",
		"tracking-tight",
		"tracking-normal",
		"tracking-wide",
		"tracking-wider",
		"tracking-widest",
	);
	add(
		"leading-none",
		"leading-tight",
		"leading-snug",
		"leading-normal",
		"leading-relaxed",
		"leading-loose",
		"leading-3",
		"leading-4",
		"leading-5",
		"leading-6",
		"leading-7",
		"leading-8",
		"leading-9",
		"leading-10",
	);
	add(
		"whitespace-normal",
		"whitespace-nowrap",
		"whitespace-pre",
		"whitespace-pre-line",
		"whitespace-pre-wrap",
		"whitespace-break-spaces",
	);
	add("break-normal", "break-words", "break-all", "break-keep");
	add("truncate", "text-ellipsis", "text-clip");

	// Borders / radius
	add(
		"rounded",
		"rounded-sm",
		"rounded-md",
		"rounded-lg",
		"rounded-xl",
		"rounded-2xl",
		"rounded-3xl",
		"rounded-full",
		"rounded-none",
	);
	for (const corner of ["t", "r", "b", "l", "tl", "tr", "bl", "br"]) {
		for (const s of [
			"",
			"-sm",
			"-md",
			"-lg",
			"-xl",
			"-2xl",
			"-3xl",
			"-full",
			"-none",
		]) {
			add(`rounded-${corner}${s}`);
		}
	}
	add(
		"border",
		"border-0",
		"border-2",
		"border-4",
		"border-8",
		"border-solid",
		"border-dashed",
		"border-dotted",
		"border-double",
		"border-none",
		"border-hidden",
	);
	for (const side of ["t", "r", "b", "l", "x", "y"]) {
		for (const w of ["", "-0", "-2", "-4", "-8"]) {
			add(`border-${side}${w}`);
		}
	}
	add(
		"divide-x",
		"divide-y",
		"divide-x-reverse",
		"divide-y-reverse",
		"divide-solid",
		"divide-dashed",
		"divide-dotted",
		"divide-double",
		"divide-none",
	);

	// Effects / filters
	add(
		"shadow",
		"shadow-sm",
		"shadow-md",
		"shadow-lg",
		"shadow-xl",
		"shadow-2xl",
		"shadow-inner",
		"shadow-none",
	);
	add(
		"opacity-0",
		"opacity-5",
		"opacity-10",
		"opacity-20",
		"opacity-25",
		"opacity-30",
		"opacity-40",
		"opacity-50",
		"opacity-60",
		"opacity-70",
		"opacity-75",
		"opacity-80",
		"opacity-90",
		"opacity-95",
		"opacity-100",
	);
	add(
		"blur",
		"blur-none",
		"blur-sm",
		"blur-md",
		"blur-lg",
		"blur-xl",
		"blur-2xl",
		"blur-3xl",
	);
	add(
		"backdrop-blur",
		"backdrop-blur-none",
		"backdrop-blur-sm",
		"backdrop-blur-md",
		"backdrop-blur-lg",
		"backdrop-blur-xl",
		"backdrop-blur-2xl",
		"backdrop-blur-3xl",
	);
	add("ring", "ring-0", "ring-1", "ring-2", "ring-4", "ring-8", "ring-inset");

	// Cursor / interactivity
	add(
		"cursor-auto",
		"cursor-default",
		"cursor-pointer",
		"cursor-wait",
		"cursor-text",
		"cursor-move",
		"cursor-help",
		"cursor-not-allowed",
		"cursor-grab",
		"cursor-grabbing",
		"cursor-crosshair",
		"cursor-zoom-in",
		"cursor-zoom-out",
	);
	add("pointer-events-none", "pointer-events-auto");
	add("select-none", "select-text", "select-all", "select-auto");
	add("appearance-none", "appearance-auto");
	add("resize-none", "resize-y", "resize-x", "resize");

	// Overflow
	for (const axis of ["", "-x", "-y"]) {
		for (const v of ["auto", "hidden", "clip", "visible", "scroll"]) {
			add(`overflow${axis}-${v}`);
		}
	}

	// Position helpers + z-index
	add("z-0", "z-10", "z-20", "z-30", "z-40", "z-50", "z-auto");
	add("isolate", "isolation-auto");

	// Transitions / animation
	add(
		"transition",
		"transition-none",
		"transition-all",
		"transition-colors",
		"transition-opacity",
		"transition-shadow",
		"transition-transform",
	);
	add(
		"duration-0",
		"duration-75",
		"duration-100",
		"duration-150",
		"duration-200",
		"duration-300",
		"duration-500",
		"duration-700",
		"duration-1000",
	);
	add("ease-linear", "ease-in", "ease-out", "ease-in-out");
	add(
		"animate-none",
		"animate-spin",
		"animate-ping",
		"animate-pulse",
		"animate-bounce",
	);
	add(
		"delay-0",
		"delay-75",
		"delay-100",
		"delay-150",
		"delay-200",
		"delay-300",
		"delay-500",
		"delay-700",
		"delay-1000",
	);

	// Transforms
	add("transform", "transform-none", "transform-gpu");
	for (const v of [
		"0",
		"50",
		"75",
		"90",
		"95",
		"100",
		"105",
		"110",
		"125",
		"150",
	]) {
		add(`scale-${v}`);
		add(`scale-x-${v}`);
		add(`scale-y-${v}`);
	}
	for (const v of ["0", "1", "2", "3", "6", "12", "45", "90", "180"]) {
		add(`rotate-${v}`);
		add(`-rotate-${v}`);
	}
	for (const v of ["0", "1", "2", "3", "6", "12"]) {
		add(`skew-x-${v}`);
		add(`skew-y-${v}`);
		add(`-skew-x-${v}`);
		add(`-skew-y-${v}`);
	}

	// Object / aspect / images
	add("aspect-auto", "aspect-square", "aspect-video");
	add(
		"object-contain",
		"object-cover",
		"object-fill",
		"object-none",
		"object-scale-down",
	);
	for (const pos of [
		"bottom",
		"center",
		"left",
		"left-bottom",
		"left-top",
		"right",
		"right-bottom",
		"right-top",
		"top",
	]) {
		add(`object-${pos}`);
	}

	// Outline / ring
	add(
		"outline-none",
		"outline",
		"outline-dashed",
		"outline-dotted",
		"outline-double",
	);

	// Spacing utilities (p, m, gap, space, inset, top/right/bottom/left)
	const SPACING_PREFIXES = [
		"p",
		"px",
		"py",
		"pt",
		"pr",
		"pb",
		"pl",
		"ps",
		"pe",
		"m",
		"mx",
		"my",
		"mt",
		"mr",
		"mb",
		"ml",
		"ms",
		"me",
		"gap",
		"gap-x",
		"gap-y",
		"space-x",
		"space-y",
		"top",
		"right",
		"bottom",
		"left",
		"start",
		"end",
		"inset",
		"inset-x",
		"inset-y",
	];
	const NEGATABLE = new Set([
		"m",
		"mx",
		"my",
		"mt",
		"mr",
		"mb",
		"ml",
		"ms",
		"me",
		"top",
		"right",
		"bottom",
		"left",
		"start",
		"end",
		"inset",
		"inset-x",
		"inset-y",
	]);
	for (const prefix of SPACING_PREFIXES) {
		for (const v of SPACING) add(`${prefix}-${v}`);
		add(`${prefix}-auto`);
		if (NEGATABLE.has(prefix)) {
			for (const v of SPACING) add(`-${prefix}-${v}`);
		}
	}

	// Sizing
	const SIZING_PREFIXES = [
		"w",
		"min-w",
		"max-w",
		"h",
		"min-h",
		"max-h",
		"size",
	];
	for (const prefix of SIZING_PREFIXES) {
		for (const v of SPACING) add(`${prefix}-${v}`);
		for (const v of FRACTIONS) add(`${prefix}-${v}`);
	}
	add(
		"w-screen",
		"h-screen",
		"w-svh",
		"h-svh",
		"w-dvh",
		"h-dvh",
		"w-lvh",
		"h-lvh",
		"w-svw",
		"h-svw",
		"w-dvw",
		"h-dvw",
		"w-lvw",
		"h-lvw",
		"max-w-prose",
		"max-w-screen-sm",
		"max-w-screen-md",
		"max-w-screen-lg",
		"max-w-screen-xl",
		"max-w-screen-2xl",
		"max-w-xs",
		"max-w-sm",
		"max-w-md",
		"max-w-lg",
		"max-w-xl",
		"max-w-2xl",
		"max-w-3xl",
		"max-w-4xl",
		"max-w-5xl",
		"max-w-6xl",
		"max-w-7xl",
		"max-w-none",
		"max-w-full",
	);

	// Color-family utilities
	const COLOR_PREFIXES = [
		"bg",
		"text",
		"border",
		"ring",
		"ring-offset",
		"fill",
		"stroke",
		"outline",
		"decoration",
		"placeholder",
		"accent",
		"caret",
		"divide",
		"shadow",
		"from",
		"via",
		"to",
	];
	for (const prefix of COLOR_PREFIXES) {
		for (const sc of SPECIAL_COLORS) add(`${prefix}-${sc}`);
		for (const c of COLORS) {
			for (const s of SHADES) add(`${prefix}-${c}-${s}`);
		}
	}

	// Grid
	for (const n of [
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
		"8",
		"9",
		"10",
		"11",
		"12",
	]) {
		add(`grid-cols-${n}`);
		add(`grid-rows-${n}`);
		add(`col-span-${n}`);
		add(`row-span-${n}`);
		add(`col-start-${n}`);
		add(`col-end-${n}`);
		add(`row-start-${n}`);
		add(`row-end-${n}`);
	}
	add(
		"grid-cols-none",
		"grid-rows-none",
		"col-span-full",
		"row-span-full",
		"grid-flow-row",
		"grid-flow-col",
		"grid-flow-dense",
		"grid-flow-row-dense",
		"grid-flow-col-dense",
		"col-auto",
		"row-auto",
		"col-start-auto",
		"col-end-auto",
		"row-start-auto",
		"row-end-auto",
	);

	// Gradients
	add(
		"bg-gradient-to-t",
		"bg-gradient-to-tr",
		"bg-gradient-to-r",
		"bg-gradient-to-br",
		"bg-gradient-to-b",
		"bg-gradient-to-bl",
		"bg-gradient-to-l",
		"bg-gradient-to-tl",
		"bg-none",
	);

	// List / table
	add("list-none", "list-disc", "list-decimal", "list-inside", "list-outside");
	add(
		"table-auto",
		"table-fixed",
		"border-collapse",
		"border-separate",
		"caption-top",
		"caption-bottom",
	);

	// SR / accessibility
	add("sr-only", "not-sr-only");

	return Array.from(out);
}

const SEED_CLASSES: ReadonlyArray<string> = buildSeedClasses();

// ── Repo class harvester ────────────────────────────────────────────────────

const repoClasses = new Set<string>();

// Fast-out cap so a runaway file (huge minified bundle, JSON) can't eat the
// main thread. Most source files are well under 200 KB.
const HARVEST_MAX_BYTES = 256 * 1024;

const ATTR_REGEX = /\bclass(?:Name)?\s*=\s*(["'`])([\s\S]*?)\1/g;
const APPLY_REGEX = /@apply\s+([^;{}\n]+)/g;
const UTIL_CALL_REGEX =
	/\b(?:cn|clsx|cva|twMerge|classnames|tw)\s*\(([\s\S]*?)\)/g;
const STRING_LITERAL_REGEX = /["'`]([^"'`\n]+)["'`]/g;

// A token "looks like a Tailwind class" if it starts with a lowercase letter
// (optionally with a leading `-` for negatives), has no spaces, and is mostly
// kebab-case. Rejects bare identifiers like "isOpen" or React event handlers
// while still picking up things like `bg-foo`, `hover:flex`, `w-[42px]`,
// `bg-blue-500/50`, and arbitrary v4 tokens.
const CLASS_TOKEN_REGEX = /^-?[a-z][a-z0-9_/.:[\]-]*$/;

function harvestFromText(text: string): void {
	if (text.length > HARVEST_MAX_BYTES) return;

	const collect = (raw: string) => {
		for (const token of raw.split(/\s+/)) {
			if (!token) continue;
			if (token.length > 80) continue;
			if (!CLASS_TOKEN_REGEX.test(token)) continue;
			repoClasses.add(token);
		}
	};

	for (const m of text.matchAll(ATTR_REGEX)) {
		collect(m[2] ?? "");
	}
	for (const m of text.matchAll(APPLY_REGEX)) {
		collect(m[1] ?? "");
	}
	for (const m of text.matchAll(UTIL_CALL_REGEX)) {
		const args = m[1] ?? "";
		for (const s of args.matchAll(STRING_LITERAL_REGEX)) {
			collect(s[1] ?? "");
		}
	}
}

// ── Class-attribute context detection ───────────────────────────────────────

const CONTEXT_LOOKBACK_LINES = 30;

const CONTEXT_OPENER_REGEX =
	/\b(?:class(?:Name)?\s*=\s*(["'`])|(?:cn|clsx|cva|twMerge|classnames|tw)\s*\([^()]*?(["'`]))/g;

function isInsideClassValue(
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): boolean {
	const startLine = Math.max(1, position.lineNumber - CONTEXT_LOOKBACK_LINES);
	let combined = "";
	for (let line = startLine; line < position.lineNumber; line++) {
		combined += `${model.getLineContent(line)}\n`;
	}
	combined += model
		.getLineContent(position.lineNumber)
		.slice(0, position.column - 1);

	let lastMatch: RegExpMatchArray | null = null;
	for (const m of combined.matchAll(CONTEXT_OPENER_REGEX)) {
		lastMatch = m;
	}
	if (!lastMatch || lastMatch.index === undefined) return false;

	const opener = lastMatch[1] ?? lastMatch[2];
	if (!opener) return false;

	const after = combined.slice(lastMatch.index + lastMatch[0].length);
	for (let i = 0; i < after.length; i++) {
		if (after[i] === "\\") {
			i++;
			continue;
		}
		if (after[i] === opener) return false;
	}
	return true;
}

function isAfterApplyDirective(
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): boolean {
	const lineText = model
		.getLineContent(position.lineNumber)
		.slice(0, position.column - 1);
	return /@apply\s/.test(lineText);
}

// ── Monaco wiring ───────────────────────────────────────────────────────────

const MARKUP_LANGUAGES = [
	"html",
	"javascript",
	"typescript",
	"javascriptreact",
	"typescriptreact",
	"vue",
	"svelte",
];

const STYLE_LANGUAGES = ["css", "scss", "less", "postcss"];

let installed = false;

export function installTailwindCompletions(monaco: MonacoModule): void {
	if (installed) return;
	installed = true;

	// Harvest class names from every model that gets created. Models are
	// reused across editor instances, so we only scan once per URI.
	const seenUris = new Set<string>();
	const scanModel = (model: Monaco.editor.ITextModel) => {
		const uri = model.uri.toString();
		if (seenUris.has(uri)) return;
		seenUris.add(uri);
		try {
			harvestFromText(model.getValue());
		} catch {
			// Best-effort scan — never let a regex blowup break the editor.
		}
	};

	for (const model of monaco.editor.getModels()) {
		scanModel(model);
	}
	monaco.editor.onDidCreateModel(scanModel);

	const buildSuggestions = (
		range: Monaco.IRange,
	): Monaco.languages.CompletionItem[] => {
		const all = new Set<string>(SEED_CLASSES);
		for (const c of repoClasses) all.add(c);

		const suggestions: Monaco.languages.CompletionItem[] = [];
		for (const label of all) {
			const resolved = resolveTailwindCss(label);
			const item: Monaco.languages.CompletionItem = {
				label,
				kind: resolved?.colorHex
					? monaco.languages.CompletionItemKind.Color
					: monaco.languages.CompletionItemKind.Constant,
				insertText: label,
				range,
				// Slight boost to repo-harvested entries so project-specific
				// tokens (custom colors, arbitrary values) surface first.
				sortText: repoClasses.has(label) ? `0_${label}` : `1_${label}`,
			};
			if (resolved) {
				item.detail = resolved.colorHex ?? firstDeclLine(resolved.css);
				item.documentation = formatCssDocs(label, resolved);
			}
			suggestions.push(item);
		}
		return suggestions;
	};

	const wordRangeFor = (
		model: Monaco.editor.ITextModel,
		position: Monaco.Position,
	): Monaco.IRange => {
		const word = model.getWordUntilPosition(position);
		return {
			startLineNumber: position.lineNumber,
			endLineNumber: position.lineNumber,
			startColumn: word.startColumn,
			endColumn: word.endColumn,
		};
	};

	monaco.languages.registerCompletionItemProvider(MARKUP_LANGUAGES, {
		triggerCharacters: [" ", '"', "'", "`", ":", "-"],
		provideCompletionItems(model, position) {
			if (!isInsideClassValue(model, position)) {
				return { suggestions: [] };
			}
			return { suggestions: buildSuggestions(wordRangeFor(model, position)) };
		},
	});

	monaco.languages.registerCompletionItemProvider(STYLE_LANGUAGES, {
		triggerCharacters: [" ", "-", ":"],
		provideCompletionItems(model, position) {
			if (!isAfterApplyDirective(model, position)) {
				return { suggestions: [] };
			}
			return { suggestions: buildSuggestions(wordRangeFor(model, position)) };
		},
	});

	// Hover: when the cursor is over a class token inside a class attribute or
	// after `@apply`, surface the resolved CSS so users can see what each
	// utility actually does.
	const hoverProvider: Monaco.languages.HoverProvider = {
		provideHover(model, position) {
			const inMarkup = isInsideClassValue(model, position);
			const inCss = isAfterApplyDirective(model, position);
			if (!inMarkup && !inCss) return null;

			const tokenAt = classTokenAt(model, position);
			if (!tokenAt) return null;

			const resolved = resolveTailwindCss(tokenAt.token);
			if (!resolved) return null;

			return {
				range: tokenAt.range,
				contents: [
					{ value: `**\`${tokenAt.token}\`**` },
					formatCssDocs(tokenAt.token, resolved),
				],
			};
		},
	};
	for (const language of MARKUP_LANGUAGES) {
		monaco.languages.registerHoverProvider(language, hoverProvider);
	}
	for (const language of STYLE_LANGUAGES) {
		monaco.languages.registerHoverProvider(language, hoverProvider);
	}
}

function firstDeclLine(css: string): string {
	const newlineIdx = css.indexOf("\n");
	return newlineIdx >= 0 ? css.slice(0, newlineIdx) : css;
}

function formatCssDocs(
	label: string,
	resolved: ResolvedCss,
): Monaco.IMarkdownString {
	const lines: string[] = [];
	lines.push("```css");
	lines.push(`.${escapeForCss(label)} {`);
	for (const decl of resolved.css.split("\n")) {
		lines.push(`  ${decl}`);
	}
	lines.push("}");
	lines.push("```");
	if (resolved.colorHex) {
		// Embedded inline swatch via emoji is unreliable across themes; just
		// surface the hex prominently below the rule.
		lines.push("");
		lines.push(`Color: \`${resolved.colorHex}\``);
	}
	return { value: lines.join("\n") };
}

// CSS class names with `:` or `[` etc. need escaping inside a real selector.
// We're rendering this in a code-block for display, so a minimal escape is
// enough — just escape the characters most commonly seen.
function escapeForCss(label: string): string {
	return label.replace(/([:/[\].])/g, "\\$1");
}

// Token boundary inside a class attribute is whitespace, the surrounding
// quote, or a JSX brace — Monaco's default word boundary splits on `:` and
// `-`, which would chop `hover:bg-blue-500` apart, so we walk it ourselves.
function classTokenAt(
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): { token: string; range: Monaco.IRange } | null {
	const lineText = model.getLineContent(position.lineNumber);
	const cursor = position.column - 1;
	const isBoundary = (ch: string | undefined) =>
		ch === undefined || /[\s"'`{}();,]/.test(ch);

	let start = cursor;
	while (start > 0 && !isBoundary(lineText[start - 1])) start--;
	let end = cursor;
	while (end < lineText.length && !isBoundary(lineText[end])) end++;

	const token = lineText.slice(start, end);
	if (!token) return null;
	return {
		token,
		range: {
			startLineNumber: position.lineNumber,
			endLineNumber: position.lineNumber,
			startColumn: start + 1,
			endColumn: end + 1,
		},
	};
}

// Exposed for tests.
export const __testing__ = {
	SEED_CLASSES,
	harvestFromText,
	repoClasses,
	isInsideClassValue,
	isAfterApplyDirective,
};
