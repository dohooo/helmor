// Layer-2 prompts. The fetcher has already pre-built the candidate
// index — the LLM's only job is to JUDGE each candidate (actionable or
// not) and, for actionable ones, write a clean propose_workspace call.

import type { TriageCandidate, TriageRepo } from "./types";

const INTRO = `You are Helmor's triage judge. The candidates listed below were
pre-fetched from the user's IM / forge sources. For EACH candidate:

  1. Decide if it is an actionable coding task the user should do.
     - "Yes" examples: a bug report, a code-review request, a
       concrete question about the user's code, a feature request
       that lands somewhere the user owns.
     - "No" examples: chat banter, status updates ("LGTM", "deployed"),
       FYI notifications, already-resolved threads, requests to
       someone other than the user.
  2. If yes, match it to ONE Helmor repo (via list_repos) and
     call \`propose_workspace\` with that repo_id.
  3. If no, call \`mark_not_actionable\` with a one-sentence reason.

You MUST decide every candidate in the list — exactly one tool call
per candidate. Do NOT analyse how to fix the bug or write code
yourself; just identify, match, and propose.`;

const READ_TOOL_HINT = `# Reading more of a candidate

Each candidate row shows you a 400-char preview. When unsure:

  - \`read_candidate(candidate_id)\` — full markdown payload (truncated
    at 8 KB). For huge bodies, pass \`grep=<keyword>\` for matching
    lines + context.
  - \`list_candidates_in_parent(parent)\` — other OPEN candidates in
    the same chat / repo. Returns metadata rows, no file IO. Use this
    when a preview makes more sense in the context of sibling messages
    (e.g. a one-line reply you can't judge without the question above).

Default to the preview when it's clear. Read only when unsure.`;

const PLAN_FORMAT = `# Plan message format

The plan_message you pass to \`propose_workspace\` becomes the first
assistant message the downstream coding agent sees. Keep it tight:

  ## Source
  Quote + sender / author + link (use the externalUrl from the candidate).
  ## Repo
  Matched repo and one-line reason for the match.
  ## Suggested Action
  ONE sentence on WHAT (not HOW).
  ## Confirm?
  Ask user to confirm before the agent starts coding.`;

function capSection(maxPerTick: number): string {
	return `# Workspace creation cap

You can create at most ${Math.max(1, maxPerTick)} workspaces per tick.
Prioritise newer candidates and stronger signals (DMs / @ mentions /
assigned to me / review requested). When you reach the cap, call
\`mark_not_actionable\` on the rest with a brief reason.`;
}

export interface BuildPromptInput {
	userPromptSuffix: string;
	maxPerTick: number;
}

export function buildSystemPrompt(input: BuildPromptInput): string {
	const sections = [
		INTRO,
		READ_TOOL_HINT,
		PLAN_FORMAT,
		capSection(input.maxPerTick),
	];
	const suffix = input.userPromptSuffix.trim();
	if (suffix.length > 0) {
		sections.push("---", "User-provided additional instructions:", suffix);
	}
	return sections.join("\n\n");
}

const PREVIEW_TRUNC = 400;

function renderCandidate(c: TriageCandidate): string {
	const lines: string[] = [];
	const sender = c.sender ?? "(unknown sender)";
	const title = c.title?.trim() || "(no title)";
	lines.push(`[${c.id}] ${c.source} · ${c.sourceKind} · ${c.sourceTime}`);
	lines.push(`  sender:  ${sender}`);
	lines.push(`  title:   ${truncate(title, 120)}`);
	if (c.preview && c.preview.trim().length > 0) {
		const preview = truncate(
			c.preview.trim().replace(/\s+/g, " "),
			PREVIEW_TRUNC,
		);
		lines.push(`  preview: ${preview}`);
	}
	if (c.externalUrl) {
		lines.push(`  link:    ${c.externalUrl}`);
	}
	lines.push(
		`  bytes:   ${c.payloadBytes} (use read_candidate to see full body)`,
	);
	return lines.join("\n");
}

export function buildTickUserMessage(
	candidates: readonly TriageCandidate[],
	repos: readonly TriageRepo[],
): string {
	if (candidates.length === 0) {
		return "No open candidates this tick. End the conversation.";
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
	const rendered = candidates.map(renderCandidate).join("\n\n");
	return `${candidates.length} open candidate(s) this tick:

${rendered}

Available Helmor repos:
${repoList}

Decide every candidate (propose_workspace OR mark_not_actionable),
then end the conversation.`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…(+${s.length - max})`;
}
