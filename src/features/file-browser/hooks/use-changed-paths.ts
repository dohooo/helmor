import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { DiffFileStatus } from "@/lib/editor-session";
import { workspaceChangesQueryOptions } from "@/lib/query-client";

export type ChangeStatusLetter = "M" | "A" | "D";

// VS Code precedence: modifications dominate, then adds, then deletes.
const PRECEDENCE: Record<ChangeStatusLetter, number> = { M: 3, A: 2, D: 1 };

function pickLoudest(
	current: ChangeStatusLetter | undefined,
	incoming: ChangeStatusLetter,
): ChangeStatusLetter {
	if (!current) return incoming;
	return PRECEDENCE[incoming] > PRECEDENCE[current] ? incoming : current;
}

function resolveStatus(
	staged: DiffFileStatus | null | undefined,
	unstaged: DiffFileStatus | null | undefined,
	fallback: DiffFileStatus,
): ChangeStatusLetter {
	// Prefer the loudest of any present status so a row only ever shows one
	// letter (matches VS Code's gutter — it never stacks markers).
	const candidates: ChangeStatusLetter[] = [];
	if (unstaged) candidates.push(unstaged);
	if (staged) candidates.push(staged);
	if (candidates.length === 0) candidates.push(fallback);
	return candidates.reduce<ChangeStatusLetter>(
		(acc, next) => pickLoudest(acc, next),
		candidates[0],
	);
}

export type ChangedPathsIndex = {
	/** Files keyed by repo-relative POSIX path → status letter. */
	files: Map<string, ChangeStatusLetter>;
	/** Ancestor folders keyed by repo-relative POSIX path → bubbled status. */
	folders: Map<string, ChangeStatusLetter>;
};

const EMPTY: ChangedPathsIndex = { files: new Map(), folders: new Map() };

export function useChangedPaths(
	workspaceRootPath: string | null,
): ChangedPathsIndex {
	const query = useQuery({
		...workspaceChangesQueryOptions(workspaceRootPath ?? "__none__"),
		enabled: workspaceRootPath !== null,
	});

	return useMemo<ChangedPathsIndex>(() => {
		const list = query.data?.items;
		if (!list || list.length === 0) return EMPTY;

		const files = new Map<string, ChangeStatusLetter>();
		const folders = new Map<string, ChangeStatusLetter>();

		for (const change of list) {
			const status = resolveStatus(
				change.stagedStatus,
				change.unstagedStatus,
				change.status,
			);
			files.set(change.path, pickLoudest(files.get(change.path), status));

			const segments = change.path.split("/");
			// Walk every ancestor folder (`a`, `a/b`, `a/b/c`) and bubble status.
			for (let i = 1; i < segments.length; i++) {
				const folderPath = segments.slice(0, i).join("/");
				folders.set(folderPath, pickLoudest(folders.get(folderPath), status));
			}
		}

		return { files, folders };
	}, [query.data]);
}
