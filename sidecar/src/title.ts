/**
 * Provider-agnostic helpers for the title-generation flow. The prompt
 * template and output parser are shared so Claude and Codex generate
 * exchangeable results.
 */

export const TITLE_GENERATION_TIMEOUT_MS = 30_000;
export const TITLE_GENERATION_FALLBACK_TIMEOUT_MS = 30_000;
const MAX_GENERATED_TITLE_CHARS = 80;
const TITLE_ELLIPSIS = "...";

const DEFAULT_BRANCH_RENAME_PROMPT = `When you generate the branch name segment for a new chat:

- Base it on the user's first message.
- Return a short English slug in lowercase with hyphens.
- Omit any branch prefix such as \`feat/\` or usernames.
- Favor clarity over cleverness.`;

const CUSTOM_PREFERENCES_INTRO =
	"IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.";

function buildBranchRenameInstructions(
	branchRenamePrompt?: string | null,
): string {
	const trimmedOverride = branchRenamePrompt?.trim();
	if (!trimmedOverride) {
		return DEFAULT_BRANCH_RENAME_PROMPT;
	}
	return `${DEFAULT_BRANCH_RENAME_PROMPT}\n\n${CUSTOM_PREFERENCES_INTRO}\n\n### User Preferences\n\n${trimmedOverride}`;
}

export function buildTitlePrompt(
	userMessage: string,
	branchRenamePrompt?: string | null,
	generateBranch = true,
): string {
	if (!generateBranch) {
		return [
			"Based on the following user message, generate a concise session title (use the same language as the user message, max 8 words).",
			"",
			"Output EXACTLY in this format (one line, nothing else):",
			"title: <the title>",
			"",
			"User message:",
			userMessage,
		].join("\n");
	}
	return [
		"Based on the following user message, generate TWO things:",
		"1. A concise session title (use the same language as the user message, max 8 words)",
		"2. A git branch name segment (English only, lowercase, hyphens for spaces, max 4 words, no prefix)",
		"",
		"Additional branch naming instructions:",
		buildBranchRenameInstructions(branchRenamePrompt),
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

export type TitleGenerationErrorLogger = (
	message: string,
	meta: Record<string, unknown>,
) => void;

export interface TitleGenerationDiagnosticsOptions {
	readonly generateBranch: boolean;
	readonly model?: string;
	readonly previewLimit?: number;
	readonly logError: TitleGenerationErrorLogger;
}

function truncateGeneratedTitle(title: string): string {
	const chars = Array.from(title);
	if (chars.length <= MAX_GENERATED_TITLE_CHARS) {
		return title;
	}
	return `${chars
		.slice(0, MAX_GENERATED_TITLE_CHARS - TITLE_ELLIPSIS.length)
		.join("")
		.trimEnd()}${TITLE_ELLIPSIS}`;
}

function normalizeGeneratedTitle(title: string): string {
	const normalized = title
		.trim()
		.replace(QUOTE_STRIP_RE, "")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.join(" ");
	return truncateGeneratedTitle(normalized);
}

export function parseTitleAndBranch(raw: string): ParsedTitle {
	let title = "";
	let branch = "";
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		const lower = trimmed.toLowerCase();
		if (lower.startsWith("title:")) {
			title = normalizeGeneratedTitle(trimmed.slice(6));
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
	// back to using a bounded normalized preview as the title.
	if (!title && raw.trim()) {
		title = normalizeGeneratedTitle(raw);
	}

	return { title, branchName: branch || undefined };
}

export function parseTitleAndBranchWithDiagnostics(
	requestId: string,
	raw: string,
	options: TitleGenerationDiagnosticsOptions,
): ParsedTitle {
	const parsed = parseTitleAndBranch(raw);
	const previewLimit = options.previewLimit ?? 200;
	const rawPreview = raw.slice(0, previewLimit);
	const model = options.model;
	const generateBranch = options.generateBranch;

	if (!parsed.title) {
		options.logError(`[${requestId}] title generation returned empty title`, {
			...(model ? { model } : {}),
			generateBranch,
			rawPreview,
		});
	}

	if (generateBranch && !parsed.branchName) {
		options.logError(
			`[${requestId}] title generation returned empty branch name`,
			{
				...(model ? { model } : {}),
				generateBranch,
				rawPreview,
			},
		);
	}

	return parsed;
}
