import "monaco-editor/min/vs/editor/editor.main.css";
import type * as Monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { installTailwindCompletions } from "./monaco-tailwind";

type MonacoModule = typeof Monaco;
type StandaloneEditor = Monaco.editor.IStandaloneCodeEditor;
type StandaloneDiffEditor = Monaco.editor.IStandaloneDiffEditor;
type TextModel = Monaco.editor.ITextModel;

type MonacoRuntime = {
	monaco: MonacoModule;
};

type DisposableLike = {
	dispose(): void;
};

type FileEditorController = {
	editor: StandaloneEditor;
	dispose(): void;
	getValue(): string;
	setValue(value: string): void;
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

function getOrCreateFileModel(
	monaco: MonacoModule,
	path: string,
	content: string,
	ownedModels: Set<TextModel>,
): TextModel {
	const uri = monaco.Uri.file(path);
	const language = resolveLanguageId(monaco, path);
	const existingModel = monaco.editor.getModel(uri);
	if (existingModel) {
		if (existingModel.getValue() !== content) {
			existingModel.setValue(content);
		}
		if (language && existingModel.getLanguageId() !== language) {
			monaco.editor.setModelLanguage(existingModel, language);
		}
		return existingModel;
	}

	const model = monaco.editor.createModel(content, language, uri);
	ownedModels.add(model);
	return model;
}

export async function createFileEditor(options: {
	container: HTMLElement;
	path: string;
	content: string;
	line?: number;
	column?: number;
}): Promise<FileEditorController> {
	const runtime = await ensureRuntime();
	const { monaco } = runtime;

	const ownedModels = new Set<TextModel>();
	let currentModel = getOrCreateFileModel(
		monaco,
		options.path,
		options.content,
		ownedModels,
	);

	// Seed content cache for future switches
	fileContentCache.set(options.path, options.content);

	const editor = monaco.editor.create(options.container, {
		automaticLayout: true,
		bracketPairColorization: { enabled: true },
		// Mount suggest/hover widgets on a body-attached layer so they can't be
		// clipped by ancestor overflow:hidden (e.g. the right inspector panel)
		// or pushed behind it by stacking-context boundaries.
		fixedOverflowWidgets: true,
		fontFamily:
			'"SF Mono","Monaco","Cascadia Mono","Roboto Mono","Menlo",monospace',
		fontLigatures: true,
		fontSize: 13,
		lineHeight: 21,
		minimap: { enabled: false },
		model: currentModel,
		padding: { top: 14, bottom: 24 },
		renderValidationDecorations: "editable",
		scrollBeyondLastLine: false,
		smoothScrolling: true,
		tabSize: 2,
		theme: themeId(desiredTheme),
		wordWrap: "on",
	});

	revealEditorPosition(editor, options.line, options.column);

	return {
		editor,
		dispose() {
			editor.dispose();
			for (const ownedModel of ownedModels) {
				if (!ownedModel.isDisposed()) {
					ownedModel.dispose();
				}
			}
			ownedModels.clear();
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

			const nextModel = getOrCreateFileModel(
				monaco,
				path,
				resolvedContent,
				ownedModels,
			);
			if (nextModel !== currentModel) {
				currentModel = nextModel;
				editor.setModel(currentModel);
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
		enableSplitViewResizing: true,
		fixedOverflowWidgets: true,
		fontFamily:
			'"SF Mono","Monaco","Cascadia Mono","Roboto Mono","Menlo",monospace',
		fontLigatures: true,
		fontSize: 13,
		hideUnchangedRegions: {
			enabled: true,
			contextLineCount: 4,
			minimumLineCount: 2,
			revealLineCount: 3,
		},
		lineHeight: 21,
		minimap: { enabled: false },
		originalEditable: false,
		padding: { top: 14, bottom: 24 },
		readOnly: true,
		renderOverviewRuler: false,
		renderSideBySide: !options.inline,
		scrollBeyondLastLine: false,
		smoothScrolling: true,
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
			installTypeScriptLanguageDefaults(monaco);
			installTailwindCompletions(monaco);
			installEditorTheme(monaco);
			installThemeObserver(monaco);

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

function installTypeScriptLanguageDefaults(monaco: MonacoModule) {
	const defaults = [
		monaco.typescript.typescriptDefaults,
		monaco.typescript.javascriptDefaults,
	];

	for (const languageDefaults of defaults) {
		languageDefaults.setDiagnosticsOptions({
			noSemanticValidation: true,
			noSyntaxValidation: false,
			noSuggestionDiagnostics: true,
		});
		languageDefaults.setCompilerOptions({
			allowJs: true,
			allowNonTsExtensions: true,
			allowSyntheticDefaultImports: true,
			checkJs: false,
			esModuleInterop: true,
			jsx: monaco.typescript.JsxEmit.ReactJSX,
			module: monaco.typescript.ModuleKind.ESNext,
			moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
			noEmit: true,
			skipLibCheck: true,
			target: monaco.typescript.ScriptTarget.ESNext,
		});
	}
}

function installEditorTheme(monaco: MonacoModule) {
	monaco.editor.defineTheme("helmor-editor-dark", {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "8A8580" },
			{ token: "string", foreground: "D5C2B0" },
			{ token: "keyword", foreground: "FF7B79" },
			{ token: "number", foreground: "F0A552" },
			{ token: "regexp", foreground: "7BD88F" },
			{ token: "type.identifier", foreground: "E069FF" },
			{ token: "identifier", foreground: "EAE5DF" },
			{ token: "identifier.function", foreground: "EAE5DF" },
			{ token: "delimiter", foreground: "BDB4AA" },
			{ token: "delimiter.bracket", foreground: "D8D0C7" },
			{ token: "operator", foreground: "FF8A84" },
			{ token: "tag", foreground: "65D482" },
			{ token: "metatag", foreground: "65D482" },
			{ token: "attribute.name", foreground: "F5A041" },
			{ token: "attribute.value", foreground: "D5C2B0" },
			{ token: "variable", foreground: "6FA8FF" },
			{ token: "variable.predefined", foreground: "6FA8FF" },
		],
		colors: {
			"editor.background": "#151210",
			"editor.foreground": "#EAE5DF",
			"editor.lineHighlightBackground": "#201D1A",
			"editor.lineHighlightBorder": "#00000000",
			"editor.selectionBackground": "#3A332E",
			"editor.inactiveSelectionBackground": "#2A2522",
			"editor.wordHighlightBackground": "#3A332E88",
			"editor.wordHighlightStrongBackground": "#4A413A88",
			"editorCursor.foreground": "#EAE5DF",
			"editorWhitespace.foreground": "#5D5650",
			"editorIndentGuide.background1": "#2A2522",
			"editorIndentGuide.activeBackground1": "#554C45",
			"editorLineNumber.foreground": "#A39D96",
			"editorLineNumber.activeForeground": "#EAE5DF",
			"editorGutter.background": "#151210",
			"editorWidget.background": "#211D1A",
			"editorWidget.border": "#3B352F",
			"editorSuggestWidget.background": "#211D1A",
			"editorSuggestWidget.border": "#3B352F",
			"editorHoverWidget.background": "#211D1A",
			"editorHoverWidget.border": "#3B352F",
			"editorError.foreground": "#FF7B79",
			"editorWarning.foreground": "#F0A552",
			"editorInfo.foreground": "#6FA8FF",
			"scrollbarSlider.background": "#eae5df26",
			"scrollbarSlider.hoverBackground": "#eae5df40",
			"scrollbarSlider.activeBackground": "#eae5df55",
			"minimap.background": "#151210",
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
