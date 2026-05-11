import manifest from "material-icon-theme/dist/material-icons.json";

import { cn } from "@/lib/utils";

interface Props {
	name: string;
	kind: "file" | "directory";
	className?: string;
}

// SVGs are served from the `material-icons` Vite plugin, which streams the
// material-icon-theme `icons/` directory in dev and copies it into
// dist/material-icons/ on build. This sidesteps rolldown's tree-shaking of
// dynamically-keyed asset URLs.
function buildIconUrl(file: string): string {
	return `/material-icons/${file}.svg`;
}

type Manifest = {
	iconDefinitions: Record<string, { iconPath: string }>;
	fileNames: Record<string, string>;
	fileExtensions: Record<string, string>;
	folderNames: Record<string, string>;
	folderNamesExpanded: Record<string, string>;
	file: string;
	folder: string;
	folderExpanded: string;
};

const m = manifest as Manifest;

function urlForIconName(iconName: string | undefined): string | undefined {
	if (!iconName) return undefined;
	const def = m.iconDefinitions[iconName];
	if (!def) return undefined;
	const file = def.iconPath
		.slice(def.iconPath.lastIndexOf("/") + 1)
		.replace(/\.svg$/, "");
	return buildIconUrl(file);
}

// Material Icon Theme leaves these extensions out of `fileExtensions` because
// VS Code routes them through its languageId map. We have no language server,
// so map the common cases by extension directly.
const EXT_OVERLAY: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	"d.ts": "typescript-def",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	tsx: "react_ts",
	jsx: "react",
};

function resolveFileUrl(name: string): string | undefined {
	const lower = name.toLowerCase();
	const byName = m.fileNames[lower] ?? m.fileNames[name];
	if (byName) return urlForIconName(byName);

	// Try progressively shorter extensions: "foo.config.ts" -> "config.ts" -> "ts".
	const parts = lower.split(".");
	for (let i = 1; i < parts.length; i++) {
		const ext = parts.slice(i).join(".");
		const byExt = m.fileExtensions[ext] ?? EXT_OVERLAY[ext];
		if (byExt) return urlForIconName(byExt);
	}
	return urlForIconName(m.file);
}

export function FileIcon({ name, kind, className }: Props) {
	// Directories render chevron + name only (VS Code-style explorer).
	if (kind === "directory") {
		return null;
	}

	const url = resolveFileUrl(name);

	if (!url) {
		return <span className={cn("size-3.5 shrink-0", className)} aria-hidden />;
	}

	return (
		<img
			src={url}
			alt=""
			aria-hidden
			className={cn("size-3.5 shrink-0", className)}
			draggable={false}
		/>
	);
}
