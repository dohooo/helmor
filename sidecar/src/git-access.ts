import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function existingDirectory(path: string): Promise<string | null> {
	try {
		const info = await stat(path);
		return info.isDirectory() ? path : null;
	} catch {
		return null;
	}
}

async function readWorktreeGitdir(cwd: string): Promise<string | null> {
	try {
		const pointer = await readFile(join(cwd, ".git"), "utf-8");
		const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
		if (!match?.[1]) {
			return null;
		}
		return resolve(cwd, match[1].trim());
	} catch {
		return null;
	}
}

async function readCommonDir(gitDir: string): Promise<string | null> {
	try {
		const pointer = await readFile(join(gitDir, "commondir"), "utf-8");
		return resolve(gitDir, pointer.trim());
	} catch {
		return null;
	}
}

/**
 * Worktrees store mutable git metadata outside the workspace directory:
 *
 * - `.git` inside the worktree is a pointer file, not a directory.
 * - The actual worktree gitdir lives under `<repo>/.git/worktrees/<name>`.
 * - Shared refs/objects/hooks live under the worktree's `commondir`.
 *
 * Sandboxed agents need both directories whitelisted or `git commit` /
 * `git push` will fail even though the worktree itself is writable.
 */
export async function resolveGitAccessDirectories(
	cwd: string | undefined,
): Promise<string[]> {
	if (!cwd) {
		return [];
	}

	const gitDirPath = await readWorktreeGitdir(cwd);
	if (!gitDirPath) {
		return [];
	}

	const gitDir = await existingDirectory(gitDirPath);
	if (!gitDir) {
		return [];
	}

	const directories = new Set<string>([gitDir]);
	const commonDirPath = await readCommonDir(gitDir);
	if (commonDirPath) {
		const commonDir = await existingDirectory(commonDirPath);
		if (commonDir) {
			directories.add(commonDir);
		}
	}

	return Array.from(directories);
}
