import type { ForgeDetection, RepoPreferences } from "@/lib/api";
import {
	type ForgePromptDialect,
	forgePromptDialect,
} from "@/lib/forge-dialect";

const TARGET_REF_PLACEHOLDER = "$" + "{TARGET_REF}";

export type RepoPreferenceKey =
	| "createPr"
	| "review"
	| "fixErrors"
	| "resolveConflicts"
	| "branchRename"
	| "general";

/** Which conflict path is being prompted. `mergeConflict` is the default
 *  (target ↔ HEAD conflict). `stashPopConflict` fires only when Helmor
 *  successfully merged but couldn't restore the user's stashed work cleanly. */
export type ResolveConflictsKind = "mergeConflict" | "stashPopConflict";

type ResolveRepoPreferencePromptArgs = {
	key: RepoPreferenceKey;
	repoPreferences?: RepoPreferences | null;
	targetBranch?: string | null;
	targetRef?: string | null;
	resolveConflictsKind?: ResolveConflictsKind;
	forge?: ForgeDetection | null;
	/** Git remote name for this workspace (e.g. "origin"). Falls back to
	 *  "origin" when unknown — matches the default git produces for a
	 *  fresh clone, so the agent doesn't see a literal `<remote>`
	 *  placeholder in the prompt. */
	remote?: string | null;
};

const DEFAULT_REMOTE = "origin";

function normalizeRemote(remote?: string | null): string {
	const trimmed = remote?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_REMOTE;
}

const DEFAULT_BRANCH_RENAME_PROMPT = `When you generate the branch name segment for a new chat:

- Base it on the user's first message.
- Return a short English slug in lowercase with hyphens.
- Omit any branch prefix such as \`feat/\` or usernames.
- Favor clarity over cleverness.`;

const CUSTOM_PREFERENCES_INTRO = `IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.`;

// Used to render `DEFAULT_REPO_PREFERENCE_PROMPTS`, which feeds the settings
// preview pane. The user has no live workspace context there, so the preview
// uses generic prose ("this workspace's target branch") rather than the
// dynamic templates. The `fixErrors` preview can come from the template
// directly because there's no per-workspace data needed there.
const PREVIEW_DIALECT = forgePromptDialect(null);

const CREATE_PR_PREVIEW = `Create a pull request for the uncommitted work in this workspace.

Do the following, in order:
1. Run \`git status\` and \`git diff\` to survey what's changed.
2. Stage everything that should ship with \`git add\`.
3. Commit with a concise, Conventional-Commits-style message (\`feat:\`, \`fix:\`, \`refactor:\`, \`chore:\`, etc.) that summarizes the change in one line.
4. Push the current branch to its remote. If needed, create the remote tracking branch with \`git push -u <remote> HEAD\`.
5. Open a pull request against this workspace's target branch using \`gh pr create\`. Use a clear PR title and a body that explains: what changed, why it changed, and any follow-up / test notes.
6. Report the PR URL in your final message so I can click it.

Don't stop to ask for confirmation — execute each step automatically. If you hit an unrecoverable error (e.g. merge conflict, pre-push hook failure), report it clearly so I can intervene.`;

const REVIEW_PREVIEW = `Review the changes on this branch relative to the target branch and report the review IN THIS CHAT ONLY.

Scope — review BOTH together:
1. Committed work past the target: \`git diff <target>...HEAD\`.
2. Uncommitted work in the worktree: \`git status\`, \`git diff\`, and \`git diff --staged\`.
Do not review code outside this diff. Read enough surrounding context to judge a change, but don't audit unrelated files.

Look for, in priority order:
- Correctness: logic errors, off-by-one, null/undefined access, wrong control flow, missing error handling, broken invariants.
- Security: injection, secret leakage, missing authz, unsafe deserialization, path traversal.
- Edge cases: empty / large input, concurrency, retry & idempotency, resource cleanup.
- Maintainability: unclear naming, dead code, leaky abstractions, missing tests for non-trivial branches.
- Performance: only when something is materially wrong (N+1, blocking I/O on a hot path) — not micro-optimizations.

Only flag what a thoughtful human reviewer would actually fix. Skip nits, taste, and speculation.

Output one chat message:
- One-line verdict (e.g. "Looks good", "One blocking issue", "Two security concerns — needs changes").
- One short paragraph summarising what the change does.
- Findings as a bulleted list, ordered blocking → major → minor. Each: severity tag, exact \`path/to/file.ext:LINE\`, what's wrong, one-sentence fix.

Do NOT modify files, stage, commit, push, or call any forge review API. The review lives in this chat — the user will read it and act.

If the diff is empty, say so in one line and stop.`;

const RESOLVE_CONFLICTS_PREVIEW = `This branch has merge conflicts with its target branch. Resolve them.

Do the following, in order:
1. Use this workspace's configured target branch as the branch to resolve against.
2. Fetch the latest target branch from its remote, then rebase or merge it into the current branch.
3. Resolve each conflict, preserving intent from both sides where possible. Explain your resolution choices briefly in the session.
4. Run the relevant tests locally to confirm nothing broke.
5. Commit the resolution and push.
6. Report the conflicted files and how you resolved them.

If a conflict is too ambiguous to resolve automatically, stop and ask.`;

function createPrPrompt(
	dialect: ForgePromptDialect,
	targetBranch?: string | null,
	remote?: string | null,
): string {
	const branch = requireTargetBranch("createPr", targetBranch);
	const remoteName = normalizeRemote(remote);
	return `Create a ${dialect.changeRequestFullName} for the uncommitted work in this workspace.

Do the following, in order:
1. Run \`git status\` and \`git diff\` to survey what's changed.
2. Stage everything that should ship with \`git add\`.
3. Commit with a concise, Conventional-Commits-style message (\`feat:\`, \`fix:\`, \`refactor:\`, \`chore:\`, etc.) that summarizes the change in one line.
4. Push the current branch to \`${remoteName}\`. If needed, create the remote tracking branch with \`git push -u ${remoteName} HEAD\`.
5. Open a ${dialect.changeRequestFullName} against \`${branch}\` using \`${dialect.createCommand(branch)}\`. Use a clear ${dialect.changeRequestName} title and a body that explains: what changed, why it changed, and any follow-up / test notes.
6. Report the ${dialect.changeRequestName} URL in your final message so I can click it.

Don't stop to ask for confirmation — execute each step automatically. If you hit an unrecoverable error (e.g. merge conflict, pre-push hook failure), report it clearly so I can intervene.`;
}

function reviewPrompt(
	targetBranch?: string | null,
	remote?: string | null,
): string {
	const branch = requireTargetBranch("review", targetBranch);
	const remoteName = normalizeRemote(remote);
	const targetRef = `${remoteName}/${branch}`;
	return `Review the changes on this branch relative to \`${targetRef}\` and report the review IN THIS CHAT ONLY.

Scope — review BOTH together:
1. Committed work past the target: \`git diff ${targetRef}...HEAD\`.
2. Uncommitted work in the worktree: \`git status\`, \`git diff\`, and \`git diff --staged\`.
Do not review code outside this diff. Read enough surrounding context to judge a change, but don't audit unrelated files.

Look for, in priority order:
- Correctness: logic errors, off-by-one, null/undefined access, wrong control flow, missing error handling, broken invariants.
- Security: injection, secret leakage, missing authz, unsafe deserialization, path traversal.
- Edge cases: empty / large input, concurrency, retry & idempotency, resource cleanup.
- Maintainability: unclear naming, dead code, leaky abstractions, missing tests for non-trivial branches.
- Performance: only when something is materially wrong (N+1, blocking I/O on a hot path) — not micro-optimizations.

Only flag what a thoughtful human reviewer would actually fix. Skip nits, taste, and speculation.

Output one chat message:
- One-line verdict (e.g. "Looks good", "One blocking issue", "Two security concerns — needs changes").
- One short paragraph summarising what the change does.
- Findings as a bulleted list, ordered blocking → major → minor. Each: severity tag, exact \`path/to/file.ext:LINE\`, what's wrong, one-sentence fix.

Do NOT modify files, stage, commit, push, or call any forge review API. The review lives in this chat — the user will read it and act.

If the diff is empty, say so in one line and stop.`;
}

function fixErrorsPrompt(dialect: ForgePromptDialect): string {
	return `${dialect.ciSystemName} is failing on the current branch. Diagnose and fix it.

Do the following, in order:
1. Use \`${dialect.ciListCommand}\` / \`${dialect.ciViewCommand}\` to inspect the most recent failing ${dialect.ciJobNoun} for this branch. Read the logs for each failing job.
2. Identify the root cause — don't just paper over the symptom. Explain your diagnosis briefly before making changes.
3. Apply the minimum set of changes needed to get CI green. Run the relevant tests / linters locally to confirm.
4. Commit the fix with a clear \`fix(ci): …\` message and push to the same branch so CI re-runs.
5. Report what was broken, what you changed, and whether the re-run is passing.`;
}

function resolveConflictsPrompt({
	targetBranch,
	targetRef,
	resolveConflictsKind,
	remote,
}: Pick<
	ResolveRepoPreferencePromptArgs,
	"targetBranch" | "targetRef" | "resolveConflictsKind" | "remote"
>): string {
	if (targetRef) {
		return resolveConflictsKind === "stashPopConflict"
			? `Resolve the conflicts from restoring the stashed uncommitted work in this branch. Don't commit. Don't push.`
			: `Bring this branch up to date with ${targetRef}. Resolve any conflicts. Preserve any uncommitted work. Don't push.`;
	}

	const branch = requireTargetBranch("resolveConflicts", targetBranch);
	const remoteName = normalizeRemote(remote);

	return `This branch has merge conflicts with \`${branch}\`, this workspace's target branch. Resolve them.

Do the following, in order:
1. Fetch the latest \`${branch}\` from \`${remoteName}\`.
2. Rebase or merge \`${branch}\` into the current branch.
3. Resolve each conflict, preserving intent from both sides where possible. Explain your resolution choices briefly in the session.
4. Run the relevant tests locally to confirm nothing broke.
5. Commit the resolution and push to \`${remoteName}\`.
6. Report the conflicted files and how you resolved them.

If a conflict is too ambiguous to resolve automatically, stop and ask.`;
}

export const DEFAULT_REPO_PREFERENCE_PROMPTS: Record<
	RepoPreferenceKey,
	string
> = {
	createPr: CREATE_PR_PREVIEW,
	review: REVIEW_PREVIEW,
	fixErrors: fixErrorsPrompt(PREVIEW_DIALECT),
	resolveConflicts: RESOLVE_CONFLICTS_PREVIEW,
	branchRename: DEFAULT_BRANCH_RENAME_PROMPT,
	general: "",
};

export const REPO_PREFERENCE_LABELS: Record<RepoPreferenceKey, string> = {
	createPr: "Create PR preferences",
	review: "Review preferences",
	fixErrors: "Fix errors preferences",
	resolveConflicts: "Resolve conflicts preferences",
	branchRename: "Branch rename preferences",
	general: "General preferences",
};

export const REPO_PREFERENCE_DESCRIPTIONS: Record<RepoPreferenceKey, string> = {
	createPr:
		"Add custom instructions sent to the agent when you click the Create PR button.",
	review:
		"Add custom instructions sent to the agent when you click Review in the inspector.",
	fixErrors:
		"Add custom instructions sent to the agent when you click the Fix errors button.",
	resolveConflicts:
		"Add custom instructions sent to the agent when you click the Resolve conflicts button.",
	branchRename:
		"Add custom instructions used when Helmor generates the first branch rename suggestion for a new chat.",
	general:
		"Add custom instructions sent to the agent at the start of every new chat.",
};

function repoPreferenceOverride(
	key: RepoPreferenceKey,
	repoPreferences?: RepoPreferences | null,
): string | null {
	const value = repoPreferences?.[key] ?? null;
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function appendUserPreferences(
	basePrompt: string,
	override: string | null,
): string {
	const trimmedBase = basePrompt.trim();
	const trimmedOverride = override?.trim();
	if (!trimmedOverride) {
		return trimmedBase;
	}
	if (!trimmedBase) {
		return `${CUSTOM_PREFERENCES_INTRO}\n\n### User Preferences\n\n${trimmedOverride}`;
	}
	return `${trimmedBase}\n\n${CUSTOM_PREFERENCES_INTRO}\n\n### User Preferences\n\n${trimmedOverride}`;
}

function requireTargetBranch(
	key: "createPr" | "review" | "resolveConflicts",
	targetBranch?: string | null,
): string {
	const branch = targetBranch?.trim();
	if (!branch) {
		throw new Error(`Missing workspace target branch for ${key} prompt.`);
	}
	return branch;
}

export function resolveRepoPreferencePreview(
	key: RepoPreferenceKey,
	repoPreferences?: RepoPreferences | null,
): string {
	return appendUserPreferences(
		DEFAULT_REPO_PREFERENCE_PROMPTS[key],
		repoPreferenceOverride(key, repoPreferences),
	);
}

export function resolveRepoPreferencePrompt({
	key,
	repoPreferences,
	targetBranch,
	targetRef,
	resolveConflictsKind = "mergeConflict",
	forge,
	remote,
}: ResolveRepoPreferencePromptArgs): string {
	const override = repoPreferenceOverride(key, repoPreferences);
	const targetPlaceholderValue = targetRef ?? targetBranch ?? null;
	const resolvedOverride =
		key === "resolveConflicts" && targetPlaceholderValue && override
			? override.replaceAll(TARGET_REF_PLACEHOLDER, targetPlaceholderValue)
			: override;

	switch (key) {
		case "resolveConflicts":
			return appendUserPreferences(
				resolveConflictsPrompt({
					targetBranch,
					targetRef,
					resolveConflictsKind,
					remote,
				}),
				resolvedOverride,
			);
		case "createPr":
			return appendUserPreferences(
				createPrPrompt(forgePromptDialect(forge), targetBranch, remote),
				resolvedOverride,
			);
		case "review":
			return appendUserPreferences(
				reviewPrompt(targetBranch, remote),
				resolvedOverride,
			);
		case "fixErrors":
			return appendUserPreferences(
				fixErrorsPrompt(forgePromptDialect(forge)),
				resolvedOverride,
			);
		default:
			return appendUserPreferences(
				DEFAULT_REPO_PREFERENCE_PROMPTS[key],
				resolvedOverride,
			);
	}
}

/** Bare "general preferences" prefix — the preamble we want the agent to
 *  receive but the user's chat bubble (and the persisted user_prompt row)
 *  should NOT contain. Returns `null` when there's nothing to prepend. The
 *  Rust side stitches `${prefix}\n\nUser request:\n${prompt}` on the wire;
 *  see `AgentSendRequest.prompt_prefix`. */
export function resolveGeneralPreferencePrefix(
	repoPreferences?: RepoPreferences | null,
): string | null {
	const general = resolveRepoPreferencePrompt({
		key: "general",
		repoPreferences,
	}).trim();
	return general ? general : null;
}

export function prependGeneralPreferencePrompt(
	prompt: string,
	repoPreferences?: RepoPreferences | null,
): string {
	const prefix = resolveGeneralPreferencePrefix(repoPreferences);
	return prefix ? `${prefix}\n\nUser request:\n${prompt}` : prompt;
}
