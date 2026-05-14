import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, scanCursorSkills } from "./cursor-skill-scanner.js";

async function makeSkill(
	root: string,
	name: string,
	body: string,
): Promise<void> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), body, "utf8");
}

describe("parseFrontmatter", () => {
	test("returns null when there is no frontmatter block", () => {
		expect(parseFrontmatter("# just markdown\n")).toBeNull();
	});

	test("parses scalar key/value pairs", () => {
		const fm = parseFrontmatter(
			"---\nname: my-skill\ndescription: hello world\n---\nbody\n",
		);
		expect(fm).toEqual({ name: "my-skill", description: "hello world" });
	});

	test("parses block-scalar `description: |`", () => {
		const fm = parseFrontmatter(
			[
				"---",
				"name: review",
				"description: |",
				"  Review the diff carefully.",
				"  Multi-line OK.",
				"---",
				"body",
			].join("\n"),
		);
		expect(fm?.description).toBe("Review the diff carefully.\nMulti-line OK.");
	});

	test("strips quotes around scalars", () => {
		const fm = parseFrontmatter(
			"---\nname: \"quoted-name\"\ndescription: 'single quoted'\n---\n",
		);
		expect(fm).toEqual({
			name: "quoted-name",
			description: "single quoted",
		});
	});
});

describe("scanCursorSkills", () => {
	let tempRoot: string;
	let projectDir: string;
	let homeDir: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "helmor-cursor-skills-"));
		projectDir = join(tempRoot, "project");
		homeDir = join(tempRoot, "home");
		await mkdir(projectDir, { recursive: true });
		await mkdir(homeDir, { recursive: true });
		// Redirect homedir() to the sandbox so user-scope scans don't leak
		// out of the temp tree.
		process.env.HOME = homeDir;
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	test("returns [] when no skill roots exist", async () => {
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills).toEqual([]);
	});

	test("discovers a project-level skill under .cursor/skills/", async () => {
		await makeSkill(
			join(projectDir, ".cursor/skills"),
			"do-thing",
			"---\nname: do-thing\ndescription: does the thing\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills).toEqual([
			{
				name: "do-thing",
				description: "does the thing",
				argumentHint: undefined,
				source: "skill",
			},
		]);
	});

	test("discovers user-level skill under ~/.agents/skills/", async () => {
		await makeSkill(
			join(homeDir, ".agents/skills"),
			"review",
			"---\nname: review\ndescription: PR review\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills.map((s) => s.name)).toEqual(["review"]);
	});

	test("honours legacy .claude/skills/ and .codex/skills/", async () => {
		await makeSkill(
			join(homeDir, ".claude/skills"),
			"claude-skill",
			"---\nname: claude-skill\ndescription: legacy claude\n---\n",
		);
		await makeSkill(
			join(homeDir, ".codex/skills"),
			"codex-skill",
			"---\nname: codex-skill\ndescription: legacy codex\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills.map((s) => s.name).sort()).toEqual([
			"claude-skill",
			"codex-skill",
		]);
	});

	test("project-scope skill shadows a user-scope skill of the same name", async () => {
		await makeSkill(
			join(homeDir, ".cursor/skills"),
			"shared",
			"---\nname: shared\ndescription: from home\n---\n",
		);
		await makeSkill(
			join(projectDir, ".cursor/skills"),
			"shared",
			"---\nname: shared\ndescription: from project\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("from project");
	});

	test("recurses into nested category directories", async () => {
		await makeSkill(
			join(projectDir, ".cursor/skills/team-a"),
			"deep-skill",
			"---\nname: deep-skill\ndescription: nested\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills.map((s) => s.name)).toEqual(["deep-skill"]);
	});

	test("falls back to folder name when frontmatter omits `name`", async () => {
		await makeSkill(
			join(projectDir, ".cursor/skills"),
			"folder-named",
			"---\ndescription: name from folder\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills).toEqual([
			{
				name: "folder-named",
				description: "name from folder",
				argumentHint: undefined,
				source: "skill",
			},
		]);
	});

	test("skips skills whose name is not a valid identifier", async () => {
		await makeSkill(
			join(projectDir, ".cursor/skills"),
			"INVALID NAME",
			"---\ndescription: bad folder\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills).toEqual([]);
	});

	test("scans additionalDirectories as project roots", async () => {
		const linked = join(tempRoot, "linked");
		await makeSkill(
			join(linked, ".cursor/skills"),
			"linked-skill",
			"---\nname: linked-skill\ndescription: from add-dir\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [linked] },
			{ homeDir },
		);
		expect(skills.map((s) => s.name)).toEqual(["linked-skill"]);
	});

	test("ignores hidden subdirectories (e.g. .git)", async () => {
		await mkdir(join(projectDir, ".cursor/skills/.git/hooks"), {
			recursive: true,
		});
		await makeSkill(
			join(projectDir, ".cursor/skills"),
			"real-skill",
			"---\nname: real-skill\ndescription: real one\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills.map((s) => s.name)).toEqual(["real-skill"]);
	});

	test("returns sorted output for stable popup order", async () => {
		await makeSkill(
			join(projectDir, ".cursor/skills"),
			"zeta",
			"---\nname: zeta\ndescription: z\n---\n",
		);
		await makeSkill(
			join(projectDir, ".cursor/skills"),
			"alpha",
			"---\nname: alpha\ndescription: a\n---\n",
		);
		const skills = await scanCursorSkills(
			{ cwd: projectDir, additionalDirectories: [] },
			{ homeDir },
		);
		expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
	});
});
