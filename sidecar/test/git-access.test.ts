import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitAccessDirectories } from "../src/git-access.js";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempRoots.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveGitAccessDirectories", () => {
	test("returns no extra directories for undefined cwd", async () => {
		await expect(resolveGitAccessDirectories(undefined)).resolves.toEqual([]);
	});

	test("returns no extra directories for a regular repository", async () => {
		const workspaceDir = makeTempDir("helmor-git-access-");
		mkdirSync(join(workspaceDir, ".git"));

		await expect(resolveGitAccessDirectories(workspaceDir)).resolves.toEqual(
			[],
		);
	});

	test("returns gitdir and commondir for a worktree pointer", async () => {
		const workspaceDir = makeTempDir("helmor-worktree-");
		const repoRoot = makeTempDir("helmor-repo-");
		const gitCommonDir = join(repoRoot, ".git");
		const gitDir = join(gitCommonDir, "worktrees", "alnitak");

		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(workspaceDir, ".git"), `gitdir: ${gitDir}\n`);
		writeFileSync(join(gitDir, "commondir"), "../../\n");

		await expect(resolveGitAccessDirectories(workspaceDir)).resolves.toEqual([
			gitDir,
			gitCommonDir,
		]);
	});
});
