import { describe, expect, it } from "vitest";
import type { ForgeDetection } from "./api";
import {
	buildCommitButtonPrompt,
	usesActionModelOverride,
} from "./commit-button-prompts";

const GITLAB_FORGE: ForgeDetection = {
	provider: "gitlab",
	host: "gitlab.example.com",
	namespace: "acme",
	repo: "repo",
	remoteUrl: "git@gitlab.example.com:acme/repo.git",
	labels: {
		providerName: "GitLab",
		cliName: "glab",
		changeRequestName: "MR",
		changeRequestFullName: "merge request",
		connectAction: "Connect GitLab",
	},
	detectionSignals: [],
};

const GITHUB_FORGE: ForgeDetection = {
	provider: "github",
	host: "github.com",
	namespace: "acme",
	repo: "repo",
	remoteUrl: "git@github.com:acme/repo.git",
	labels: {
		providerName: "GitHub",
		cliName: "gh",
		changeRequestName: "PR",
		changeRequestFullName: "pull request",
		connectAction: "Connect GitHub",
	},
	detectionSignals: [],
};

describe("buildCommitButtonPrompt", () => {
	it("uses the action model only for simple bounded action sessions", () => {
		expect(usesActionModelOverride("create-pr")).toBe(true);
		expect(usesActionModelOverride("commit-and-push")).toBe(true);
		expect(usesActionModelOverride("open-pr")).toBe(true);
		expect(usesActionModelOverride("fix")).toBe(false);
		expect(usesActionModelOverride("resolve-conflicts")).toBe(false);
		expect(usesActionModelOverride("push")).toBe(false);
	});

	it("appends create-pr preferences after the built-in prompt", () => {
		expect(
			buildCommitButtonPrompt(
				"create-pr",
				{
					createPr: "Always include rollout notes.",
				},
				"release/next",
			),
		).toContain("### User Preferences\n\nAlways include rollout notes.");
	});

	it("passes the target branch into create-pr prompts (GitHub default)", () => {
		expect(buildCommitButtonPrompt("create-pr", {}, "release/next")).toContain(
			"gh pr create --base release/next",
		);
	});

	it("passes the target branch into create-pr prompts (GitHub forge)", () => {
		const prompt = buildCommitButtonPrompt(
			"create-pr",
			{},
			"release/next",
			GITHUB_FORGE,
		);
		expect(prompt).toContain("Create a pull request");
		expect(prompt).toContain(
			"Open a pull request against `release/next` using `gh pr create --base release/next`.",
		);
	});

	it("passes the target branch into create-pr prompts (GitLab forge)", () => {
		const prompt = buildCommitButtonPrompt(
			"create-pr",
			{},
			"release/next",
			GITLAB_FORGE,
		);
		expect(prompt).toContain("Create a merge request");
		expect(prompt).toContain(
			"Open a merge request against `release/next` using `glab mr create --target-branch release/next`.",
		);
		expect(prompt).not.toContain("`gh pr create`");
		expect(prompt).not.toContain("the repository's default branch");
	});

	it("passes the target branch into resolve-conflicts prompts", () => {
		expect(
			buildCommitButtonPrompt("resolve-conflicts", {}, "release/next"),
		).toContain(
			"This branch has merge conflicts with `release/next`, this workspace's target branch.",
		);
	});

	it("appends fix-errors preferences after the built-in prompt", () => {
		expect(
			buildCommitButtonPrompt("fix", {
				fixErrors: "Run targeted tests before broad suites.",
			}),
		).toContain(
			"### User Preferences\n\nRun targeted tests before broad suites.",
		);
	});

	it("uses GitHub CI inspection commands by default", () => {
		const prompt = buildCommitButtonPrompt("fix", null);
		expect(prompt).toContain("`gh run list` / `gh run view`");
	});

	it("uses GitLab CI inspection commands for GitLab forge", () => {
		const prompt = buildCommitButtonPrompt("fix", null, null, GITLAB_FORGE);
		expect(prompt).toContain("GitLab CI is failing");
		expect(prompt).toContain("`glab ci list` / `glab ci view`");
		expect(prompt).toContain("failing pipeline");
		expect(prompt).not.toContain("`gh run list`");
	});

	it("uses the same root-cause guidance for both forges", () => {
		const githubPrompt = buildCommitButtonPrompt("fix", null);
		const gitlabPrompt = buildCommitButtonPrompt(
			"fix",
			null,
			null,
			GITLAB_FORGE,
		);
		const clause = "— don't just paper over the symptom";
		expect(githubPrompt).toContain(clause);
		expect(gitlabPrompt).toContain(clause);
	});

	it("uses GitHub reopen commands for open-pr by default", () => {
		const prompt = buildCommitButtonPrompt("open-pr", null);
		expect(prompt).toContain("Reopen the closed pull request");
		expect(prompt).toContain("`gh pr reopen` + `gh pr comment`");
	});

	it("uses GitLab reopen commands for open-pr on GitLab forge", () => {
		const prompt = buildCommitButtonPrompt("open-pr", null, null, GITLAB_FORGE);
		expect(prompt).toContain("Reopen the closed merge request");
		expect(prompt).toContain("`glab mr reopen` + `glab mr note`");
	});

	it("appends create-pr preferences after the GitLab prompt", () => {
		const prompt = buildCommitButtonPrompt(
			"create-pr",
			{ createPr: "Mention deployment order." },
			"release/next",
			GITLAB_FORGE,
		);

		expect(prompt).toContain("`glab mr create --target-branch release/next`");
		expect(prompt).toContain(
			"### User Preferences\n\nMention deployment order.",
		);
	});

	it("uses pure-git instructions for commit-and-push regardless of forge", () => {
		const githubPrompt = buildCommitButtonPrompt(
			"commit-and-push",
			null,
			null,
			GITHUB_FORGE,
		);
		const gitlabPrompt = buildCommitButtonPrompt(
			"commit-and-push",
			null,
			null,
			GITLAB_FORGE,
		);
		expect(githubPrompt).toBe(gitlabPrompt);
		expect(githubPrompt).toContain("Commit and push all uncommitted work");
	});

	it("substitutes the workspace remote into the commit-and-push prompt", () => {
		const prompt = buildCommitButtonPrompt(
			"commit-and-push",
			null,
			null,
			null,
			"upstream",
		);
		expect(prompt).toContain("Push the current branch to `upstream`.");
		expect(prompt).toContain("`git push -u upstream HEAD`");
		expect(prompt).not.toContain("<remote>");
	});

	it("falls back to `origin` when the workspace remote is missing", () => {
		const prompt = buildCommitButtonPrompt("commit-and-push", null, null);
		expect(prompt).toContain("`git push -u origin HEAD`");
		expect(prompt).not.toContain("<remote>");
	});

	it("substitutes the workspace remote into the create-pr prompt", () => {
		const prompt = buildCommitButtonPrompt(
			"create-pr",
			{},
			"release/next",
			GITHUB_FORGE,
			"upstream",
		);
		expect(prompt).toContain("Push the current branch to `upstream`.");
		expect(prompt).toContain("`git push -u upstream HEAD`");
		expect(prompt).not.toContain("<remote>");
	});

	it("diffs against the target ref and stays chat-only by default", () => {
		const prompt = buildCommitButtonPrompt(
			"review",
			null,
			"main",
			null,
			"origin",
		);
		expect(prompt).toContain("relative to `origin/main`");
		expect(prompt).toContain("git diff origin/main...HEAD");
		expect(prompt).toContain("IN THIS CHAT ONLY");
		expect(prompt).toContain("Do NOT modify files");
		// Forge-agnostic — never touches gh/glab.
		expect(prompt).not.toContain("pull request");
		expect(prompt).not.toContain("merge request");
		expect(prompt).not.toContain("gh pr");
		expect(prompt).not.toContain("glab mr");
	});

	it("produces the same review prompt regardless of forge (GitLab vs GitHub)", () => {
		const githubPrompt = buildCommitButtonPrompt(
			"review",
			null,
			"main",
			null,
			"origin",
		);
		const gitlabPrompt = buildCommitButtonPrompt(
			"review",
			null,
			"main",
			GITLAB_FORGE,
			"origin",
		);
		expect(gitlabPrompt).toBe(githubPrompt);
	});

	it("appends review preferences after the built-in prompt", () => {
		expect(
			buildCommitButtonPrompt(
				"review",
				{ review: "Focus on security regressions." },
				"main",
				null,
				"origin",
			),
		).toContain("### User Preferences\n\nFocus on security regressions.");
	});
});
