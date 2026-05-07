export type DiffFileStatus = "M" | "A" | "D";

export type DiffOpenOptions = {
	fileStatus: DiffFileStatus;
	originalRef?: string;
	modifiedRef?: string;
};

/** "source" = Monaco editor; "preview" = rendered streamdown view. Only meaningful for markdown paths. */
export type EditorViewMode = "source" | "preview";

export type EditorSessionState = {
	kind: "file" | "diff";
	path: string;
	line?: number;
	column?: number;
	originalText?: string;
	modifiedText?: string;
	inline?: boolean;
	dirty?: boolean;
	mtimeMs?: number | null;
	/** File change status — determines fetch strategy and display mode. */
	fileStatus?: DiffFileStatus;
	/** Git ref for the original (left) side. Defaults to "HEAD". */
	originalRef?: string;
	/** Git ref for the modified (right) side. Omit to read from working tree. */
	modifiedRef?: string;
	/** Markdown view mode. Ignored for non-markdown paths. */
	viewMode?: EditorViewMode;
};

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

export function isMarkdownPath(path: string): boolean {
	const lower = path.toLowerCase();
	return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type InspectorFileItem = {
	path: string;
	absolutePath: string;
	name: string;
	status: "M" | "A" | "D";
	insertions: number;
	deletions: number;
	/** Set when the file has staged changes (HEAD vs index). */
	stagedStatus?: "M" | "A" | "D" | null;
	/** Set when the file has unstaged changes (index vs working tree, or
	 * untracked). */
	unstagedStatus?: "M" | "A" | "D" | null;
	/** Set when the file has committed changes on the current branch
	 * relative to the target branch (merge-base..HEAD). Used by the
	 * "Branch Changes" section. */
	committedStatus?: "M" | "A" | "D" | null;
};

const DEFAULT_INSPECTOR_RELATIVE_FILES: Array<{
	path: string;
	status: InspectorFileItem["status"];
}> = [
	{ path: "src/App.tsx", status: "M" },
	{
		path: "src/features/inspector/index.tsx",
		status: "M",
	},
	{
		path: "src/features/panel/index.tsx",
		status: "A",
	},
	{ path: "src/lib/api.ts", status: "M" },
	{ path: "src-tauri/src/lib.rs", status: "D" },
];

export function buildFallbackInspectorFileItems(
	workspaceRootPath?: string | null,
): InspectorFileItem[] {
	if (!workspaceRootPath) {
		return [];
	}

	const normalizedRoot = normalizePath(workspaceRootPath);

	return DEFAULT_INSPECTOR_RELATIVE_FILES.map((file) => ({
		path: file.path,
		absolutePath: joinPath(normalizedRoot, file.path),
		name: getBaseName(file.path),
		status: file.status,
		insertions: 0,
		deletions: 0,
	}));
}

export function describeEditorPath(
	path: string,
	workspaceRootPath?: string | null,
): string {
	const normalizedPath = normalizePath(path);
	const normalizedRoot = workspaceRootPath
		? normalizePath(workspaceRootPath)
		: null;

	if (!normalizedRoot) {
		return normalizedPath;
	}

	if (normalizedPath === normalizedRoot) {
		return ".";
	}

	const rootWithSlash = normalizedRoot.endsWith("/")
		? normalizedRoot
		: `${normalizedRoot}/`;

	if (normalizedPath.startsWith(rootWithSlash)) {
		return normalizedPath.slice(rootWithSlash.length);
	}

	return normalizedPath;
}

export function getBaseName(path: string): string {
	const normalizedPath = normalizePath(path);
	const segments = normalizedPath.split("/");
	return segments[segments.length - 1] ?? normalizedPath;
}

export function isPathWithinRoot(
	path: string,
	workspaceRootPath?: string | null,
): boolean {
	if (!workspaceRootPath) {
		return false;
	}

	const normalizedPath = normalizePath(path);
	const normalizedRoot = normalizePath(workspaceRootPath);

	if (normalizedPath === normalizedRoot) {
		return true;
	}

	const rootWithSlash = normalizedRoot.endsWith("/")
		? normalizedRoot
		: `${normalizedRoot}/`;

	return normalizedPath.startsWith(rootWithSlash);
}

function joinPath(root: string, relativePath: string): string {
	return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}
