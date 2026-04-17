/**
 * Provider-agnostic helpers for the title-generation flow. The prompt
 * template and output parser are shared so Claude and Codex generate
 * exchangeable results.
 */

export const TITLE_GENERATION_TIMEOUT_MS = 30_000;
export const TITLE_GENERATION_FALLBACK_TIMEOUT_MS = 30_000;

export function buildTitlePrompt(userMessage: string): string {
	return [
		"Based on the following user message, generate TWO things:",
		"1. A concise session title (use the same language as the user message, max 8 words)",
		"2. A git branch name segment (English only, lowercase, hyphens for spaces, max 4 words, no prefix)",
		"",
		"Output EXACTLY in this format (two lines, nothing else):",
		"title: <the title>",
		"branch: <the-branch-name>",
		"",
		"User message:",
		userMessage,
	].join("\n");
}

const QUOTE_STRIP_RE =
	/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g;
const BRANCH_INVALID_RE = /[^a-z0-9-]/g;
const BRANCH_DASH_COLLAPSE_RE = /-+/g;
const BRANCH_TRIM_DASH_RE = /^-|-$/g;

export interface ParsedTitle {
	readonly title: string;
	readonly branchName: string | undefined;
}

export function parseTitleAndBranch(raw: string): ParsedTitle {
	let title = "";
	let branch = "";
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		const lower = trimmed.toLowerCase();
		if (lower.startsWith("title:")) {
			title = trimmed.slice(6).trim().replace(QUOTE_STRIP_RE, "").trim();
		} else if (lower.startsWith("branch:")) {
			branch = trimmed
				.slice(7)
				.trim()
				.replace(BRANCH_INVALID_RE, "")
				.replace(BRANCH_DASH_COLLAPSE_RE, "-")
				.replace(BRANCH_TRIM_DASH_RE, "");
		}
	}

	// If structured parsing failed but the model returned *something*, fall
	// back to using the raw text as the title (still better than empty).
	if (!title && raw.trim()) {
		title = raw.trim().replace(QUOTE_STRIP_RE, "").trim();
	}

	return { title, branchName: branch || undefined };
}
