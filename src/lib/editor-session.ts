export type DiffFileStatus = "M" | "A" | "D";

/** Git stage-0 (clean index) syntax. `read_file_at_ref` concatenates
 * `<ref>:<path>`, so passing `":0"` yields `:0:<path>` — the canonical
 * way to read a file's staged content. Used by the unstaged area as its
 * diff base, and by the staged area as its modified side. */
export const INDEX_REF = ":0";

export type DiffOpenOptions = {
	fileStatus: DiffFileStatus;
	originalRef?: string;
	modifiedRef?: string;
};

/** What the inspector knows about the open editor target. We carry the
 * diff bases (not just the path) so that "same file opened from Staged"
 * vs "same file opened from Unstaged" can render as distinct selections —
 * comparing path alone highlights both rows at once. Null when no file is
 * open. */
export type ActiveEditorTarget = {
	path: string;
	originalRef?: string;
	modifiedRef?: string;
};

/** Returns true when the open editor's diff bases match the supplied
 * area refs. Used by inspector groups to decide whether *their* row for
 * a given path should render selected — comparing path alone breaks down
 * when the same file lives in multiple areas (Staged + Unstaged) with
 * different bases. Refs are compared strictly so `undefined`
 * ("read modified side from disk") matches itself. */
export function isActiveEditorTarget(
	target: ActiveEditorTarget | null | undefined,
	originalRef: string | undefined,
	modifiedRef: string | undefined,
): target is ActiveEditorTarget {
	return (
		!!target &&
		target.originalRef === originalRef &&
		target.modifiedRef === modifiedRef
	);
}

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
	/** Lines added/removed in the staged area (HEAD vs index). */
	stagedInsertions: number;
	stagedDeletions: number;
	/** Lines added/removed in the unstaged area (index vs working tree).
	 * Includes line counts for untracked files. */
	unstagedInsertions: number;
	unstagedDeletions: number;
	/** Lines added/removed in the committed area (target_ref vs HEAD). */
	committedInsertions: number;
	committedDeletions: number;
	/** True when the file is binary (no meaningful line diff). */
	isBinary?: boolean;
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
		stagedInsertions: 0,
		stagedDeletions: 0,
		unstagedInsertions: 0,
		unstagedDeletions: 0,
		committedInsertions: 0,
		committedDeletions: 0,
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
