import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitAccessModule = "../src/git-access.ts?git-access-unit";
const { resolveGitAccessDirectories } = (await import(gitAccessModule)) as {
	resolveGitAccessDirectories: (cwd: string | undefined) => Promise<string[]>;
};

function makeTempDir(roots: string[], prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function cleanupTempDirs(roots: string[]): void {
	for (const dir of roots.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("resolveGitAccessDirectories", () => {
	test("returns no extra directories for undefined cwd", async () => {
		await expect(resolveGitAccessDirectories(undefined)).resolves.toEqual([]);
	});

	test("returns no extra directories for a regular repository", async () => {
		const tempRoots: string[] = [];
		try {
			const workspaceDir = makeTempDir(tempRoots, "helmor-git-access-");
			mkdirSync(join(workspaceDir, ".git"));

			await expect(resolveGitAccessDirectories(workspaceDir)).resolves.toEqual(
				[],
			);
		} finally {
			cleanupTempDirs(tempRoots);
		}
	});

	test("returns gitdir and commondir for a worktree pointer", async () => {
		const tempRoots: string[] = [];
		try {
			const workspaceDir = makeTempDir(tempRoots, "helmor-worktree-");
			const repoRoot = makeTempDir(tempRoots, "helmor-repo-");
			const gitCommonDir = join(repoRoot, ".git");
			const gitDir = join(gitCommonDir, "worktrees", "alnitak");

			mkdirSync(gitDir, { recursive: true });
			writeFileSync(join(workspaceDir, ".git"), `gitdir: ${gitDir}\n`);
			writeFileSync(join(gitDir, "commondir"), "../../\n");

			await expect(resolveGitAccessDirectories(workspaceDir)).resolves.toEqual([
				gitDir,
				gitCommonDir,
			]);
		} finally {
			cleanupTempDirs(tempRoots);
		}
	});
});
