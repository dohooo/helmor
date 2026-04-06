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
};

export type InspectorFileItem = {
	path: string;
	absolutePath: string;
	name: string;
	status: "M" | "A" | "D";
};

const DEFAULT_INSPECTOR_RELATIVE_FILES: Array<{
	path: string;
	status: InspectorFileItem["status"];
}> = [
	{ path: "src/App.tsx", status: "M" },
	{
		path: "src/components/workspace-inspector-sidebar.tsx",
		status: "M",
	},
	{
		path: "src/components/workspace-panel.tsx",
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
