import type { ForgeDetection } from "@/lib/api";

// Forge-specific bits that get dropped into agent prompts. Everything else in
// our prompts is forge-agnostic (plain git, prose). Keep this surface tight —
// only add a field when the prompt actually needs to render it.
export type ForgePromptDialect = {
	/** Short label, e.g. "PR" / "MR". */
	changeRequestName: string;
	/** Long label, e.g. "pull request" / "merge request". */
	changeRequestFullName: string;
	/** Forge CLI binary, e.g. "gh" / "glab". */
	cliName: string;
	/** Renders the create-PR/MR command for a given target branch. */
	createCommand: (targetBranch: string) => string;
	/** Reopen a closed PR/MR, e.g. "gh pr reopen" / "glab mr reopen". */
	reopenCommand: string;
	/** Comment on a PR/MR, e.g. "gh pr comment" / "glab mr note". */
	commentCommand: string;
	/** List CI runs, e.g. "gh run list" / "glab ci list". */
	ciListCommand: string;
	/** Inspect a CI run, e.g. "gh run view" / "glab ci view". */
	ciViewCommand: string;
	/** CI system name as it appears in prose, e.g. "CI" / "GitLab CI". */
	ciSystemName: string;
	/** What the CI system calls a single run, e.g. "run" / "pipeline". */
	ciJobNoun: string;
};

const GITHUB_DIALECT: ForgePromptDialect = {
	changeRequestName: "PR",
	changeRequestFullName: "pull request",
	cliName: "gh",
	createCommand: (branch) => `gh pr create --base ${branch}`,
	reopenCommand: "gh pr reopen",
	commentCommand: "gh pr comment",
	ciListCommand: "gh run list",
	ciViewCommand: "gh run view",
	ciSystemName: "CI",
	ciJobNoun: "run",
};

const GITLAB_DIALECT: ForgePromptDialect = {
	changeRequestName: "MR",
	changeRequestFullName: "merge request",
	cliName: "glab",
	createCommand: (branch) => `glab mr create --target-branch ${branch}`,
	reopenCommand: "glab mr reopen",
	commentCommand: "glab mr note",
	ciListCommand: "glab ci list",
	ciViewCommand: "glab ci view",
	ciSystemName: "GitLab CI",
	ciJobNoun: "pipeline",
};

/** Pick the prompt dialect for the given forge. Falls back to GitHub. */
export function forgePromptDialect(
	forge?: ForgeDetection | null,
): ForgePromptDialect {
	return forge?.provider === "gitlab" ? GITLAB_DIALECT : GITHUB_DIALECT;
}
