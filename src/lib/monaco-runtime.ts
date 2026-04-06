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

export async function createFileEditor(options: {
	container: HTMLElement;
	path: string;
	content: string;
	line?: number;
	column?: number;
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
		fontFamily:
			'"SF Mono","Monaco","Cascadia Mono","Roboto Mono","Menlo",monospace',
		fontLigatures: true,
		fontSize: 13,
		lineHeight: 21,
		minimap: { enabled: false },
		model,
		padding: { top: 14, bottom: 24 },
		renderValidationDecorations: "editable",
		scrollBeyondLastLine: false,
		smoothScrolling: true,
		tabSize: 2,
		theme: "helmor-editor-dark",
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
		enableSplitViewResizing: true,
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
		theme: "helmor-editor-dark",
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

			return { monaco };
		})();
	}

	return runtimePromise;
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
			"diffEditor.insertedLineBackground": "#2d3a2b66",
			"diffEditor.insertedTextBackground": "#5a7a5255",
			"diffEditor.removedLineBackground": "#4a2e2e66",
			"diffEditor.removedTextBackground": "#8c5e5e55",
		},
	});
	monaco.editor.setTheme("helmor-editor-dark");
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
