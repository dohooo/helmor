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

	revealEditorPosition(editor, options.line, options.column);

	const currentModel = model;

	return {
		editor,
		dispose() {
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

	return {
		editor,
		dispose() {
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

// Sync Monaco's theme with the app's `dark` class on <html>. Avoids having
// callers import this module just to push a theme update, which would pull
// Monaco's runtime into the critical path on every theme change.
function installThemeObserver(monaco: MonacoModule) {
	if (
		typeof document === "undefined" ||
		typeof MutationObserver === "undefined"
	) {
		return;
	}
	const syncTheme = () => {
		const nextTheme = detectInitialTheme();
		if (nextTheme === desiredTheme) {
			return;
		}
		desiredTheme = nextTheme;
		monaco.editor.setTheme(themeId(nextTheme));
	};
	const observer = new MutationObserver(syncTheme);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class"],
	});
	syncTheme();
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

function installEditorTheme(monaco: MonacoModule) {
	monaco.editor.defineTheme("helmor-editor-dark", {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "868584" },
			{ token: "string", foreground: "c9b18f" },
			{ token: "keyword", foreground: "c5a3a8" },
			{ token: "number", foreground: "c6b48a" },
			{ token: "regexp", foreground: "9ea693" },
			{ token: "type.identifier", foreground: "a9b0c6" },
			{ token: "identifier", foreground: "faf9f6" },
			{ token: "delimiter", foreground: "afaeac" },
		],
		colors: {
			"editor.background": "#161514",
			"editor.foreground": "#FAF9F6",
			"editor.lineHighlightBackground": "#1f1e1d",
			"editor.lineHighlightBorder": "#00000000",
			"editor.selectionBackground": "#353534",
			"editor.inactiveSelectionBackground": "#2a2928",
			"editor.wordHighlightBackground": "#35353488",
			"editor.wordHighlightStrongBackground": "#45454588",
			"editorCursor.foreground": "#FAF9F6",
			"editorWhitespace.foreground": "#595755",
			"editorIndentGuide.background1": "#2b2a29",
			"editorIndentGuide.activeBackground1": "#4b4946",
			"editorLineNumber.foreground": "#868584",
			"editorLineNumber.activeForeground": "#FAF9F6",
			"editorGutter.background": "#161514",
			"editorWidget.background": "#1e1d1c",
			"editorWidget.border": "#343332",
			"editorSuggestWidget.background": "#1e1d1c",
			"editorSuggestWidget.border": "#343332",
			"editorHoverWidget.background": "#1e1d1c",
			"editorHoverWidget.border": "#343332",
			"scrollbarSlider.background": "#faf9f626",
			"scrollbarSlider.hoverBackground": "#faf9f640",
			"scrollbarSlider.activeBackground": "#faf9f655",
			"minimap.background": "#161514",
			"diffEditor.insertedLineBackground": "#2ea04318",
			"diffEditor.insertedTextBackground": "#2ea04340",
			"diffEditor.removedLineBackground": "#da363318",
			"diffEditor.removedTextBackground": "#da363340",
			"diffEditorGutter.insertedLineBackground": "#2ea04326",
			"diffEditorGutter.removedLineBackground": "#da363326",
			"diffEditorOverview.insertedForeground": "#2ea04399",
			"diffEditorOverview.removedForeground": "#da363399",
			"diffEditor.diagonalFill": "#faf9f608",
		},
	});
	monaco.editor.defineTheme("helmor-editor-light", {
		base: "vs",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "7a7775" },
			{ token: "string", foreground: "8a6b3d" },
			{ token: "keyword", foreground: "8a3d51" },
			{ token: "number", foreground: "8a6e2f" },
			{ token: "regexp", foreground: "5a6b3d" },
			{ token: "type.identifier", foreground: "3d4d75" },
			{ token: "identifier", foreground: "1a1918" },
			{ token: "delimiter", foreground: "5a5857" },
		],
		colors: {
			"editor.background": "#FFFFFF",
			"editor.foreground": "#1a1918",
			"editor.lineHighlightBackground": "#f4f3f1",
			"editor.lineHighlightBorder": "#00000000",
			"editor.selectionBackground": "#c9d9ef",
			"editor.inactiveSelectionBackground": "#dde3ec",
			"editor.wordHighlightBackground": "#c9d9ef88",
			"editor.wordHighlightStrongBackground": "#a8c1e288",
			"editorCursor.foreground": "#1a1918",
			"editorWhitespace.foreground": "#c7c5c2",
			"editorIndentGuide.background1": "#eceae6",
			"editorIndentGuide.activeBackground1": "#c7c5c2",
			"editorLineNumber.foreground": "#a4a19d",
			"editorLineNumber.activeForeground": "#1a1918",
			"editorGutter.background": "#FFFFFF",
			"editorWidget.background": "#f8f7f5",
			"editorWidget.border": "#e4e2de",
			"editorSuggestWidget.background": "#f8f7f5",
			"editorSuggestWidget.border": "#e4e2de",
			"editorHoverWidget.background": "#f8f7f5",
			"editorHoverWidget.border": "#e4e2de",
			"scrollbarSlider.background": "#1a191826",
			"scrollbarSlider.hoverBackground": "#1a191840",
			"scrollbarSlider.activeBackground": "#1a191855",
			"minimap.background": "#FFFFFF",
			"diffEditor.insertedLineBackground": "#2ea04318",
			"diffEditor.insertedTextBackground": "#2ea04333",
			"diffEditor.removedLineBackground": "#da363318",
			"diffEditor.removedTextBackground": "#da363333",
			"diffEditorGutter.insertedLineBackground": "#2ea04326",
			"diffEditorGutter.removedLineBackground": "#da363326",
			"diffEditorOverview.insertedForeground": "#2ea04399",
			"diffEditorOverview.removedForeground": "#da363399",
			"diffEditor.diagonalFill": "#1a19180a",
		},
	});
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
