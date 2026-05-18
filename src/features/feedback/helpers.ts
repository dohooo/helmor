import {
	FALLBACK_ISSUE_TITLE,
	HELMOR_UPSTREAM_SLUG,
	ISSUE_TITLE_MAX_CHARS,
} from "./constants";

/**
 * Split the user's feedback into a `(title, body)` pair for the GitHub issue
 * API. Short input becomes the title alone; longer input has the first chunk
 * as title and the remainder as body. Unicode-aware so CJK characters aren't
 * sliced mid-codepoint.
 */
export function splitIssueTitleAndBody(input: string): {
	title: string;
	body: string;
} {
	const trimmed = input.trim();
	if (!trimmed) {
		return { title: FALLBACK_ISSUE_TITLE, body: "" };
	}
	const chars = Array.from(trimmed);
	if (chars.length <= ISSUE_TITLE_MAX_CHARS) {
		return { title: trimmed, body: "" };
	}
	const title = chars.slice(0, ISSUE_TITLE_MAX_CHARS).join("");
	const body = chars.slice(ISSUE_TITLE_MAX_CHARS).join("").trimStart();
	return { title, body };
}

/**
 * Default prompt template sent to the agent when a user picks "Quick fix".
 * Embeds the user's feedback AND the full contribution lifecycle so the user
 * never has to re-explain "commit, push, open a PR" later — the agent
 * already knows the whole shape of the task on turn 1.
 */
export function buildPromptTemplate(input: string): string {
	return [
		`I'm contributing to ${HELMOR_UPSTREAM_SLUG}. Please help me ship this.`,
		"",
		"## My feedback",
		input.trim(),
		"",
		"## How to handle this",
		"1. Explore the code, ask anything unclear, propose a minimal change.",
		'2. Implement once I agree. Do not commit, push, or open a PR before I say "go ahead".',
		`3. After my "go ahead": commit, push to origin, then \`gh pr create --repo ${HELMOR_UPSTREAM_SLUG} --base main\` with a title and body generated from the diff.`,
		"",
		'Reply using the same language I used in the "## My feedback" section above.',
	].join("\n");
}
