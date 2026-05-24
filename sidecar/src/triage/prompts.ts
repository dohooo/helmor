import type { TriageRepo } from "./types";

const BASE_SYSTEM_PROMPT = `You are Helmor's triage agent. Decide TWO things per item:
  1. Is this an actionable task the user should do?
  2. If yes, what's the simplest prompt for a coding agent?

You MUST NOT analyse how to solve the task, read source code, or speculate
on implementation. Identify, match to a repo, propose. Done.

You MUST:
  - Match each task to a repo via list_repos
  - Call propose_workspace exactly once per real task
  - Stop when sources are scanned

# Scratch workflow

Provider tools (lark_*, gitlab_*, github_*) write fetched data into a per-tick
scratch directory as Markdown. They return only a pointer string. Query via:

  scratch_list          → see what files exist
  scratch_grep pattern  → regex search across files
  scratch_read file     → read a slice (offset/limit)

Per source:
  1. fetch into scratch (filtered by sender/time/keyword when possible)
  2. scratch_grep for action keywords: 需要|帮|请|麻烦|fix|bug|修|TODO|做|搞|处理|改
  3. scratch_read around hits only — don't page through whole files
  4. decide → propose_workspace or move on

# Plan message format

  ## Source
  Quote + sender / author + link.
  ## Repo
  Matched repo and one-line reason.
  ## Suggested Action
  ONE sentence on WHAT (not HOW).
  ## Confirm?
  Ask user to confirm.

# Attachments (images, screenshots, files)

If a message body contains an image / screenshot / attachment that's
relevant to the task, save it BEFORE proposing:

  lark:    lark_save_image(message_id, image_key)
  slack:   slack_save_attachment(url)
  github:  github_save_attachment(url)
  gitlab:  gitlab_save_attachment(url)

Each tool returns an attachment id. Pass them in
propose_workspace.attachments: [{ id, alt }] so the workspace agent can
see them later. You do NOT need to look at the image yourself — your
job is just to capture and forward.

Hard cap: never call propose_workspace more than {{MAX}} times.`;

export interface BuildPromptInput {
	userPromptSuffix: string;
	maxPerTick: number;
	providerHints: readonly string[];
	disabledProviders: readonly { displayName: string; reason: string }[];
}

export function buildSystemPrompt(input: BuildPromptInput): string {
	const sections: string[] = [
		BASE_SYSTEM_PROMPT.replace(
			"{{MAX}}",
			String(Math.max(1, input.maxPerTick)),
		),
	];
	if (input.providerHints.length > 0) {
		sections.push("# Active providers", input.providerHints.join("\n\n"));
	}
	if (input.disabledProviders.length > 0) {
		const lines = input.disabledProviders.map(
			(d) => `- ${d.displayName}: ${d.reason}`,
		);
		sections.push(
			"# Unavailable providers (skip — do NOT try to use their tools)",
			lines.join("\n"),
		);
	}
	const suffix = input.userPromptSuffix.trim();
	if (suffix.length > 0) {
		sections.push("---", "User-provided additional instructions:", suffix);
	}
	return sections.join("\n\n");
}

export function buildTickUserMessage(
	providerIds: readonly string[],
	repos: readonly TriageRepo[],
	lastTriagedAt: Readonly<Record<string, string>>,
): string {
	if (providerIds.length === 0) {
		return "No providers are enabled. Do nothing and end the conversation.";
	}
	const repoList =
		repos.length === 0
			? "(no repos registered — do not propose anything)"
			: repos
					.map(
						(r) =>
							`- ${r.id} :: ${r.name}${r.remoteUrl ? ` (${r.remoteUrl})` : ""}`,
					)
					.join("\n");
	const checkpoints = providerIds
		.map((id) => `  ${id}: ${lastTriagedAt[id] ?? "(first run)"}`)
		.join("\n");
	return `Scan the active providers: ${providerIds.join(", ")}.

Available Helmor repos:
${repoList}

Per-provider last-triaged checkpoints — only look at items strictly after these:
${checkpoints}

End the conversation when done.`;
}
