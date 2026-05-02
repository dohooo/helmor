import { describe, expect, it } from "vitest";
import type { ForgeDetection } from "./api";
import {
	prependGeneralPreferencePrompt,
	resolveRepoPreferencePreview,
	resolveRepoPreferencePrompt,
} from "./repo-preferences-prompts";

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

describe("repo preference prompts", () => {
	const targetRefPlaceholder = "$" + "{TARGET_REF}";

	it("leaves the general preview empty when no override exists", () => {
		expect(resolveRepoPreferencePreview("general", {})).toBe("");
	});

	it("uses generic prose in the create-pr preview", () => {
		// Preview has no live workspace context — keep the original generic
		// wording rather than substituting placeholders into the template.
		const preview = resolveRepoPreferencePreview("createPr", {});
		expect(preview).toContain("this workspace's target branch");
		expect(preview).toContain("`gh pr create`");
		expect(preview).not.toContain("<target-branch>");
	});

	it("appends the override after the target-specific create-pr prompt", () => {
		expect(
			resolveRepoPreferencePrompt({
				key: "createPr",
				repoPreferences: { createPr: "Ship it exactly this way." },
				targetBranch: "develop",
			}),
		).toContain("### User Preferences\n\nShip it exactly this way.");
	});

	it("uses the workspace target branch in the create-pr prompt (GitHub default)", () => {
		expect(
			resolveRepoPreferencePrompt({
				key: "createPr",
				repoPreferences: {},
				targetBranch: "develop",
			}),
		).toContain(
			"Open a pull request against `develop` using `gh pr create --base develop`.",
		);
	});

	it("uses the GitLab dialect in the create-pr prompt when forge is GitLab", () => {
		const prompt = resolveRepoPreferencePrompt({
			key: "createPr",
			repoPreferences: {},
			targetBranch: "develop",
			forge: GITLAB_FORGE,
		});
		expect(prompt).toContain("Create a merge request");
		expect(prompt).toContain(
			"Open a merge request against `develop` using `glab mr create --target-branch develop`.",
		);
	});

	it("throws instead of falling back when create-pr has no target branch", () => {
		expect(() =>
			resolveRepoPreferencePrompt({
				key: "createPr",
				repoPreferences: {},
			}),
		).toThrow("Missing workspace target branch for createPr prompt.");
	});

	it("uses the GitLab dialect in the fix-errors prompt when forge is GitLab", () => {
		const prompt = resolveRepoPreferencePrompt({
			key: "fixErrors",
			repoPreferences: {},
			forge: GITLAB_FORGE,
		});
		expect(prompt).toContain("`glab ci list` / `glab ci view`");
	});

	it("renders the intent-only resolve-conflicts prompt for merge conflicts", () => {
		expect(
			resolveRepoPreferencePrompt({
				key: "resolveConflicts",
				repoPreferences: {},
				targetRef: "origin/main",
			}),
		).toBe(
			"Bring this branch up to date with origin/main. Resolve any conflicts. Preserve any uncommitted work. Don't push.",
		);
	});

	it("renders a narrow prompt for stash-pop conflicts", () => {
		expect(
			resolveRepoPreferencePrompt({
				key: "resolveConflicts",
				repoPreferences: {},
				targetRef: "origin/main",
				resolveConflictsKind: "stashPopConflict",
			}),
		).toBe(
			"Resolve the conflicts from restoring the stashed uncommitted work in this branch. Don't commit. Don't push.",
		);
	});

	it("uses the workspace target branch in the resolve-conflicts prompt", () => {
		expect(
			resolveRepoPreferencePrompt({
				key: "resolveConflicts",
				repoPreferences: {},
				targetBranch: "develop",
			}),
		).toContain(
			"This branch has merge conflicts with `develop`, this workspace's target branch.",
		);
	});

	it("throws instead of falling back when resolve-conflicts has no target branch", () => {
		expect(() =>
			resolveRepoPreferencePrompt({
				key: "resolveConflicts",
				repoPreferences: {},
			}),
		).toThrow("Missing workspace target branch for resolveConflicts prompt.");
	});

	it("prepends the general prompt to the first user message", () => {
		expect(
			prependGeneralPreferencePrompt("Fix the failing tests.", {
				general: "Always explain the root cause first.",
			}),
		).toBe(
			"IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.\n\n### User Preferences\n\nAlways explain the root cause first.\n\nUser request:\nFix the failing tests.",
		);
	});

	it("appends resolve-conflicts overrides after the intent-only prompt", () => {
		expect(
			resolveRepoPreferencePrompt({
				key: "resolveConflicts",
				repoPreferences: {
					resolveConflicts: `Prefer rebase when possible. Target: ${targetRefPlaceholder}.`,
				},
				targetRef: "origin/main",
			}),
		).toBe(
			"Bring this branch up to date with origin/main. Resolve any conflicts. Preserve any uncommitted work. Don't push.\n\nIMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.\n\n### User Preferences\n\nPrefer rebase when possible. Target: origin/main.",
		);
	});

	it("leaves the first user message unchanged when general is empty", () => {
		expect(prependGeneralPreferencePrompt("Fix the failing tests.", {})).toBe(
			"Fix the failing tests.",
		);
	});

	it("returns the review-pr default prompt when no override is set", () => {
		const prompt = resolveRepoPreferencePrompt({
			key: "reviewPr",
			repoPreferences: {},
		});
		expect(prompt).toContain("Review the open pull request");
		expect(prompt).toContain("IN THIS CHAT ONLY");
		expect(prompt).toContain("`gh pr diff`");
		expect(prompt).not.toContain("### User Preferences");
	});

	it("appends review-pr overrides after the built-in prompt", () => {
		const prompt = resolveRepoPreferencePrompt({
			key: "reviewPr",
			repoPreferences: { reviewPr: "Always check for missing tests." },
		});
		expect(prompt).toContain("Review the open pull request");
		expect(prompt).toContain(
			"### User Preferences\n\nAlways check for missing tests.",
		);
	});

	it("uses the GitLab dialect in the review-pr prompt when forge is GitLab", () => {
		const prompt = resolveRepoPreferencePrompt({
			key: "reviewPr",
			repoPreferences: {},
			forge: GITLAB_FORGE,
		});
		expect(prompt).toContain("Review the open merge request");
		expect(prompt).toContain("`glab mr diff`");
		expect(prompt).not.toContain("`gh pr diff`");
	});

	it("uses generic prose in the review-pr preview", () => {
		const preview = resolveRepoPreferencePreview("reviewPr", {});
		expect(preview).toContain("Review the open pull request");
		expect(preview).toContain("IN THIS CHAT ONLY");
	});
});
