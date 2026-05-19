import "monaco-editor/min/vs/editor/editor.main.css";
import type * as Monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoModule = typeof Monaco;
type StandaloneEditor = Monaco.editor.IStandaloneCodeEditor;
type StandaloneDiffEditor = Monaco.editor.IStandaloneDiffEditor;

type MonacoRuntime = {
	monaco: MonacoModule;
};

type TsDiagnosticsDefaults = {
	setDiagnosticsOptions(options: {
		noSemanticValidation: boolean;
		noSyntaxValidation: boolean;
		noSuggestionDiagnostics: boolean;
	}): void;
};

type JsonDiagnosticsDefaults = {
	setDiagnosticsOptions(options: { validate: boolean }): void;
};

type ValidationDefaults = {
	setOptions(options: { validate: boolean }): void;
};

type MonacoLanguageDefaults = MonacoModule & {
	languages: MonacoModule["languages"] & {
		typescript: {
			typescriptDefaults: TsDiagnosticsDefaults;
			javascriptDefaults: TsDiagnosticsDefaults;
		};
		json: { jsonDefaults: JsonDiagnosticsDefaults };
		css: {
			cssDefaults: ValidationDefaults;
			scssDefaults: ValidationDefaults;
			lessDefaults: ValidationDefaults;
		};
		html: { htmlDefaults: ValidationDefaults };
	};
};

type DisposableLike = {
	dispose(): void;
};

type FileEditorController = {
	editor: StandaloneEditor;
	dispose(): void;
	getValue(): string;
	setValue(value: string): void;
	setReadOnly(readOnly: boolean): void;
	revealPosition(line?: number, column?: number): void;
	/** Move keyboard focus into the editor's hidden textarea. */
	focus(): void;
	onDidChangeModelContent(callback: (value: string) => void): DisposableLike;
	/** Swap the active model. Returns false if no cached model and no content provided. */
	switchFile(
		path: string,
		content?: string,
		line?: number,
		column?: number,
	): boolean;
};

type DiffEditorController = {
	editor: StandaloneDiffEditor;
	dispose(): void;
	setTexts(options: {
		originalText: string;
		modifiedText: string;
		inline: boolean;
	}): void;
	/** Move keyboard focus into the modified-side textarea. */
	focus(): void;
};

let runtimePromise: Promise<MonacoRuntime> | null = null;

/** Content cache for pre-fetched files — avoids IPC on first switch. */
const fileContentCache = new Map<string, string>();

type EditorTheme = "light" | "dark";

/** Pending theme applied once runtime is ready (or the current one). */
let desiredTheme: EditorTheme = detectInitialTheme();

function detectInitialTheme(): EditorTheme {
	if (typeof document === "undefined") {
		return "dark";
	}
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function themeId(theme: EditorTheme): string {
	return theme === "dark" ? "helmor-editor-dark" : "helmor-editor-light";
}

export async function createFileEditor(options: {
	container: HTMLElement;
	path: string;
	content: string;
	line?: number;
	column?: number;
	readOnly?: boolean;
}): Promise<FileEditorController> {
	const runtime = await ensureRuntime();
	const { monaco } = runtime;

	const language = resolveLanguageId(monaco, options.path);

	// Single model shared across all file switches — avoids editor.setModel()
	// which causes a blank frame during the detach→attach cycle.
	const model = monaco.editor.createModel(options.content, language);

	// Seed content cache for future switches
	fileContentCache.set(options.path, options.content);

	const editor = monaco.editor.create(options.container, {
		automaticLayout: true,
		bracketPairColorization: { enabled: true },
		codeLens: false,
		colorDecorators: false,
		contextmenu: false,
		fontFamily:
			'"SF Mono","Monaco","Cascadia Mono","Roboto Mono","Menlo",monospace',
		fontLigatures: true,
		fontSize: 13,
		folding: false,
		glyphMargin: false,
		hover: { enabled: false },
		lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
		lineHeight: 21,
		links: false,
		minimap: { enabled: false },
		model,
		occurrencesHighlight: "off",
		padding: { top: 14, bottom: 24 },
		parameterHints: { enabled: false },
		quickSuggestions: false,
		readOnly: Boolean(options.readOnly),
		readOnlyMessage: { value: "Click Edit to modify this file." },
		renderValidationDecorations: "off",
		scrollBeyondLastLine: false,
		selectionHighlight: false,
		smoothScrolling: true,
		suggestOnTriggerCharacters: false,
		tabSize: 2,
		theme: themeId(desiredTheme),
		wordWrap: "on",
	});
	const findWidgetTooltipPatch = suppressFindWidgetCloseTooltip(
		options.container,
	);

	revealEditorPosition(editor, options.line, options.column);

	const currentModel = model;

	return {
		editor,
		dispose() {
			findWidgetTooltipPatch.dispose();
			editor.dispose();
		},
		getValue() {
			return currentModel.getValue();
		},
		setValue(value: string) {
			if (currentModel.getValue() === value) {
				return;
			}

			currentModel.setValue(value);
		},
		setReadOnly(readOnly: boolean) {
			editor.updateOptions({ readOnly });
		},
		revealPosition(line?: number, column?: number) {
			revealEditorPosition(editor, line, column);
		},
		focus() {
			editor.focus();
		},
		onDidChangeModelContent(callback) {
			return currentModel.onDidChangeContent(() => {
				callback(currentModel.getValue());
			});
		},
		switchFile(path: string, content?: string, line?: number, column?: number) {
			// Resolve content: explicit param → cache → give up
			const resolvedContent = content ?? fileContentCache.get(path);
			if (resolvedContent === undefined) {
				return false;
			}

			// In-place update: setValue + setModelLanguage on the SAME model.
			// Unlike editor.setModel(), this never detaches the DOM → zero blank frames.
			currentModel.setValue(resolvedContent);

			const nextLanguage = resolveLanguageId(monaco, path);
			if (nextLanguage && currentModel.getLanguageId() !== nextLanguage) {
				monaco.editor.setModelLanguage(currentModel, nextLanguage);
			}

			// Keep cache fresh for future switches back to this file
			fileContentCache.set(path, resolvedContent);

			revealEditorPosition(editor, line, column);
			return true;
		},
	};
}

export async function createDiffEditor(options: {
	container: HTMLElement;
	path: string;
	originalText: string;
	modifiedText: string;
	inline: boolean;
}): Promise<DiffEditorController> {
	const runtime = await ensureRuntime();
	const { monaco } = runtime;
	const language = resolveLanguageId(monaco, options.path);

	const originalUri = monaco.Uri.file(options.path).with({
		query: "helmor-review=original",
	});
	const modifiedUri = monaco.Uri.file(options.path).with({
		query: "helmor-review=modified",
	});
	monaco.editor.getModel(originalUri)?.dispose();
	monaco.editor.getModel(modifiedUri)?.dispose();

	const originalModel = monaco.editor.createModel(
		options.originalText,
		language,
		originalUri,
	);
	const modifiedModel = monaco.editor.createModel(
		options.modifiedText,
		language,
		modifiedUri,
	);

	const editor = monaco.editor.createDiffEditor(options.container, {
		automaticLayout: true,
		codeLens: false,
		colorDecorators: false,
		contextmenu: false,
		enableSplitViewResizing: true,
		fontFamily:
			'"SF Mono","Monaco","Cascadia Mono","Roboto Mono","Menlo",monospace',
		fontLigatures: true,
		fontSize: 13,
		folding: false,
		glyphMargin: false,
		hideUnchangedRegions: {
			enabled: true,
			contextLineCount: 4,
			minimumLineCount: 2,
			revealLineCount: 3,
		},
		hover: { enabled: false },
		lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
		lineHeight: 21,
		links: false,
		minimap: { enabled: false },
		occurrencesHighlight: "off",
		originalEditable: false,
		padding: { top: 14, bottom: 24 },
		parameterHints: { enabled: false },
		quickSuggestions: false,
		readOnly: true,
		renderValidationDecorations: "off",
		renderOverviewRuler: false,
		renderSideBySide: !options.inline,
		scrollBeyondLastLine: false,
		selectionHighlight: false,
		smoothScrolling: true,
		suggestOnTriggerCharacters: false,
		theme: themeId(desiredTheme),
	});

	editor.setModel({
		original: originalModel,
		modified: modifiedModel,
	});
	const findWidgetTooltipPatch = suppressFindWidgetCloseTooltip(
		options.container,
	);

	return {
		editor,
		dispose() {
			findWidgetTooltipPatch.dispose();
			editor.dispose();
			originalModel.dispose();
			modifiedModel.dispose();
		},
		setTexts({ originalText, modifiedText, inline }) {
			if (originalModel.getValue() !== originalText) {
				originalModel.setValue(originalText);
			}
			if (modifiedModel.getValue() !== modifiedText) {
				modifiedModel.setValue(modifiedText);
			}
			editor.updateOptions({ renderSideBySide: !inline });
		},
		focus() {
			// Modified side carries the user's edits when they jump to Edit mode,
			// so it's the more useful focus target than the read-only original.
			editor.getModifiedEditor().focus();
		},
	};
}

/** Cache file contents so future switchFile calls resolve instantly (no IPC). */
export function preWarmFileContents(
	files: ReadonlyArray<{ absolutePath: string; content: string }>,
) {
	for (const file of files) {
		fileContentCache.set(file.absolutePath, file.content);
	}
}

export function syncVirtualFile(path: string, content: string) {
	fileContentCache.set(path, content);
}

function suppressFindWidgetCloseTooltip(
	container: HTMLElement,
): DisposableLike {
	const abortController =
		typeof AbortController === "undefined" ? null : new AbortController();
	const patchedElements = new WeakSet<HTMLElement>();
	const stopHover = (event: Event) => {
		event.stopImmediatePropagation();
	};

	const patchHoverTargets = () => {
		const targets = container.querySelectorAll<HTMLElement>(
			[
				".find-widget > .button.codicon-widget-close",
				".find-widget .codicon-find-selection",
			].join(","),
		);
		for (const target of targets) {
			target.removeAttribute("title");
			if (patchedElements.has(target) || !abortController) continue;
			patchedElements.add(target);
			target.addEventListener("mouseover", stopHover, {
				capture: true,
				signal: abortController.signal,
			});
		}
	};

	patchHoverTargets();
	if (typeof MutationObserver === "undefined") {
		return {
			dispose() {
				abortController?.abort();
			},
		};
	}

	const observer = new MutationObserver(patchHoverTargets);
	observer.observe(container, {
		attributes: true,
		childList: true,
		subtree: true,
		attributeFilter: ["title", "class"],
	});

	return {
		dispose() {
			abortController?.abort();
			observer.disconnect();
		},
	};
}

async function ensureRuntime(): Promise<MonacoRuntime> {
	if (!runtimePromise) {
		runtimePromise = (async () => {
			const monaco = await import("monaco-editor");

			installMonacoEnvironment();
			installEditorTheme(monaco);
			installThemeObserver(monaco);
			disableLanguageDiagnostics(monaco);

			return { monaco };
		})();
	}

	return runtimePromise;
}

// Sync Monaco theme with `<html>` class changes. Re-defines both themes on
// every class mutation — light/dark toggle AND preset theme switch both flip
// CSS variables, so the editor `colors` map must be recomputed.
function installThemeObserver(monaco: MonacoModule) {
	if (
		typeof document === "undefined" ||
		typeof MutationObserver === "undefined"
	) {
		return;
	}
	const syncTheme = () => {
		const nextTheme = detectInitialTheme();
		defineHelmorThemes(monaco);
		desiredTheme = nextTheme;
		monaco.editor.setTheme(themeId(nextTheme));
	};
	const observer = new MutationObserver(syncTheme);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class"],
	});
}

function disableLanguageDiagnostics(monaco: MonacoModule) {
	const defaults = monaco as unknown as MonacoLanguageDefaults;
	defaults.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
		noSemanticValidation: true,
		noSyntaxValidation: true,
		noSuggestionDiagnostics: true,
	});
	defaults.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
		noSemanticValidation: true,
		noSyntaxValidation: true,
		noSuggestionDiagnostics: true,
	});
	defaults.languages.json.jsonDefaults.setDiagnosticsOptions({
		validate: false,
	});
	defaults.languages.css.cssDefaults.setOptions({
		validate: false,
	});
	defaults.languages.css.scssDefaults.setOptions({
		validate: false,
	});
	defaults.languages.css.lessDefaults.setOptions({
		validate: false,
	});
	defaults.languages.html.htmlDefaults.setOptions({
		validate: false,
	});
}

function installMonacoEnvironment() {
	const target = globalThis as typeof globalThis & {
		MonacoEnvironment?: {
			getWorker: (_moduleId: string, label: string) => Worker;
		};
	};

	if (target.MonacoEnvironment) {
		return;
	}

	target.MonacoEnvironment = {
		getWorker(_moduleId, label) {
			switch (label) {
				case "json":
					return new jsonWorker();
				case "css":
				case "scss":
				case "less":
					return new cssWorker();
				case "html":
				case "handlebars":
				case "razor":
					return new htmlWorker();
				case "typescript":
				case "javascript":
					return new tsWorker();
				default:
					return new editorWorker();
			}
		},
	};
}

// Syntax highlighting rules — kept hard-coded so code colors stay stable
// across the active app theme. (Locked, per the theme-system design.) Only
// the editor chrome (background, gutter, widgets, scrollbar, diff) follows
// CSS variables.
const SYNTAX_RULES_DARK = [
	{ token: "comment", foreground: "868584" },
	{ token: "string", foreground: "c9b18f" },
	{ token: "keyword", foreground: "c5a3a8" },
	{ token: "number", foreground: "c6b48a" },
	{ token: "regexp", foreground: "9ea693" },
	{ token: "type.identifier", foreground: "a9b0c6" },
	{ token: "identifier", foreground: "faf9f6" },
	{ token: "delimiter", foreground: "afaeac" },
];
const SYNTAX_RULES_LIGHT = [
	{ token: "comment", foreground: "7a7775" },
	{ token: "string", foreground: "8a6b3d" },
	{ token: "keyword", foreground: "8a3d51" },
	{ token: "number", foreground: "8a6e2f" },
	{ token: "regexp", foreground: "5a6b3d" },
	{ token: "type.identifier", foreground: "3d4d75" },
	{ token: "identifier", foreground: "1a1918" },
	{ token: "delimiter", foreground: "5a5857" },
];

// Reusable hidden probe — `resolveCssColor` writes a `var(--x)` to its
// background-color and reads the computed rgb back. Cached across calls so
// theme rebuild costs ~30 reads, not 30 element churns.
let cssColorProbe: HTMLDivElement | null = null;
function getCssColorProbe(): HTMLDivElement {
	if (!cssColorProbe) {
		cssColorProbe = document.createElement("div");
		cssColorProbe.style.cssText =
			"position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;";
		document.body.appendChild(cssColorProbe);
	}
	return cssColorProbe;
}

function toHexByte(n: number): string {
	return Math.max(0, Math.min(255, Math.round(n)))
		.toString(16)
		.padStart(2, "0");
}

/**
 * Resolve a CSS variable to a hex Monaco accepts.
 * `alphaOverride` (0–1) lets callers stamp a custom transparency without
 * defining a new --var (useful for soft overlays like inactive selection).
 */
function resolveCssColor(varName: string, alphaOverride?: number): string {
	const probe = getCssColorProbe();
	probe.style.backgroundColor = `var(${varName})`;
	const computed = window.getComputedStyle(probe).backgroundColor;
	const match = computed.match(
		/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*([\d.]+))?\s*\)/,
	);
	if (!match) return "#000000";
	const r = Number.parseFloat(match[1]);
	const g = Number.parseFloat(match[2]);
	const b = Number.parseFloat(match[3]);
	const baseAlpha = match[4] !== undefined ? Number.parseFloat(match[4]) : 1;
	const alpha = alphaOverride !== undefined ? alphaOverride : baseAlpha;
	const aHex = alpha >= 1 ? "" : toHexByte(alpha * 255);
	return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}${aHex}`;
}

function buildHelmorTheme(isDark: boolean) {
	const editorBg = resolveCssColor("--editor-content-bg");
	const editorFg = resolveCssColor("--editor-content-fg");
	const lineActive = resolveCssColor("--editor-line-active-bg");
	const selection = resolveCssColor("--editor-selection-bg");
	const cursor = resolveCssColor("--editor-cursor");
	const gutterBg = resolveCssColor("--editor-gutter-bg");
	const gutterFg = resolveCssColor("--editor-gutter-fg");
	const widgetBg = resolveCssColor("--bg-overlay");
	const widgetBorder = resolveCssColor("--border-default");
	const scrollbarBase = resolveCssColor("--fg-default", 0.15);
	const scrollbarHover = resolveCssColor("--fg-default", 0.25);
	const scrollbarActive = resolveCssColor("--fg-default", 0.35);
	const indentGuide = resolveCssColor("--border-subtle");
	const indentGuideActive = resolveCssColor("--border-strong");
	// Diff colors come from the workspace status palette — semantic and locked,
	// so they match the sidebar PR badges across every theme. Alpha is layered
	// on top to dim them into editor-overlay use.
	const diffInsertLine = resolveCssColor("--workspace-pr-open-accent", 0.09);
	const diffInsertText = resolveCssColor(
		"--workspace-pr-open-accent",
		isDark ? 0.25 : 0.2,
	);
	const diffRemoveLine = resolveCssColor("--workspace-pr-closed-accent", 0.09);
	const diffRemoveText = resolveCssColor(
		"--workspace-pr-closed-accent",
		isDark ? 0.25 : 0.2,
	);
	const diffGutterInsert = resolveCssColor("--workspace-pr-open-accent", 0.15);
	const diffGutterRemove = resolveCssColor(
		"--workspace-pr-closed-accent",
		0.15,
	);
	const diffOverviewInsert = resolveCssColor("--workspace-pr-open-accent", 0.6);
	const diffOverviewRemove = resolveCssColor(
		"--workspace-pr-closed-accent",
		0.6,
	);
	const diffDiagonal = resolveCssColor("--fg-default", isDark ? 0.03 : 0.04);

	return {
		base: (isDark ? "vs-dark" : "vs") as "vs" | "vs-dark",
		inherit: true,
		rules: isDark ? SYNTAX_RULES_DARK : SYNTAX_RULES_LIGHT,
		colors: {
			"editor.background": editorBg,
			"editor.foreground": editorFg,
			"editor.lineHighlightBackground": lineActive,
			"editor.lineHighlightBorder": "#00000000",
			"editor.selectionBackground": selection,
			"editor.inactiveSelectionBackground": resolveCssColor(
				"--editor-selection-bg",
				0.5,
			),
			"editor.wordHighlightBackground": resolveCssColor(
				"--editor-selection-bg",
				0.4,
			),
			"editor.wordHighlightStrongBackground": resolveCssColor(
				"--editor-selection-bg",
				0.55,
			),
			"editorCursor.foreground": cursor,
			"editorWhitespace.foreground": resolveCssColor("--fg-disabled"),
			"editorIndentGuide.background1": indentGuide,
			"editorIndentGuide.activeBackground1": indentGuideActive,
			"editorLineNumber.foreground": gutterFg,
			"editorLineNumber.activeForeground": editorFg,
			"editorGutter.background": gutterBg,
			"editorWidget.background": widgetBg,
			"editorWidget.border": widgetBorder,
			"editorSuggestWidget.background": widgetBg,
			"editorSuggestWidget.border": widgetBorder,
			"editorHoverWidget.background": widgetBg,
			"editorHoverWidget.border": widgetBorder,
			"scrollbarSlider.background": scrollbarBase,
			"scrollbarSlider.hoverBackground": scrollbarHover,
			"scrollbarSlider.activeBackground": scrollbarActive,
			"minimap.background": editorBg,
			"diffEditor.insertedLineBackground": diffInsertLine,
			"diffEditor.insertedTextBackground": diffInsertText,
			"diffEditor.removedLineBackground": diffRemoveLine,
			"diffEditor.removedTextBackground": diffRemoveText,
			"diffEditorGutter.insertedLineBackground": diffGutterInsert,
			"diffEditorGutter.removedLineBackground": diffGutterRemove,
			"diffEditorOverview.insertedForeground": diffOverviewInsert,
			"diffEditorOverview.removedForeground": diffOverviewRemove,
			"diffEditor.diagonalFill": diffDiagonal,
		},
	};
}

function defineHelmorThemes(monaco: MonacoModule) {
	monaco.editor.defineTheme("helmor-editor-dark", buildHelmorTheme(true));
	monaco.editor.defineTheme("helmor-editor-light", buildHelmorTheme(false));
}

function installEditorTheme(monaco: MonacoModule) {
	defineHelmorThemes(monaco);
	monaco.editor.setTheme(themeId(desiredTheme));
}

function resolveLanguageId(
	monaco: MonacoModule,
	path: string,
): string | undefined {
	const normalizedPath = path.replace(/\\/g, "/");
	const fileName = normalizedPath.split("/").pop()?.toLowerCase() ?? "";
	const extension = fileName.includes(".")
		? fileName.slice(fileName.lastIndexOf("."))
		: "";

	const explicitMap: Record<string, string> = {
		".cjs": "javascript",
		".css": "css",
		".go": "go",
		".html": "html",
		".java": "java",
		".js": "javascript",
		".json": "json",
		".jsx": "javascript",
		".md": "markdown",
		".mjs": "javascript",
		".py": "python",
		".rs": "rust",
		".scss": "scss",
		".sh": "shell",
		".sql": "sql",
		".toml": "ini",
		".ts": "typescript",
		".tsx": "typescript",
		".txt": "plaintext",
		".yaml": "yaml",
		".yml": "yaml",
	};

	if (fileName === "dockerfile") {
		return "dockerfile";
	}

	if (fileName.endsWith(".test.tsx") || fileName.endsWith(".spec.tsx")) {
		return "typescript";
	}

	if (explicitMap[extension]) {
		return explicitMap[extension];
	}

	return monaco.languages.getLanguages().find((language) => {
		const extensions = language.extensions ?? [];
		const filenames = language.filenames ?? [];
		return extensions.includes(extension) || filenames.includes(fileName);
	})?.id;
}

function revealEditorPosition(
	editor: StandaloneEditor,
	line?: number,
	column?: number,
) {
	if (!line) {
		return;
	}

	const position = {
		lineNumber: Math.max(1, line),
		column: Math.max(1, column ?? 1),
	};
	editor.setPosition(position);
	editor.revealPositionInCenter(position);
	editor.focus();
}
