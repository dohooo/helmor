import type { SerializedEditorState } from "lexical";

import {
	FALLBACK_ISSUE_TITLE,
	HELMOR_UPSTREAM_SLUG,
	ISSUE_TITLE_MAX_CHARS,
} from "./constants";

export type EnvironmentInfo = {
	os: string;
	appVersion: string;
};

/**
 * Derive an issue title from the user's feedback input. Takes the first line,
 * trims it, and truncates by Unicode code points (so multi-byte CJK characters
 * aren't sliced mid-codepoint). Returns a fallback when the input is empty.
 */
export function buildIssueTitle(input: string): string {
	const firstLine = input.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (!firstLine) {
		return FALLBACK_ISSUE_TITLE;
	}
	const chars = Array.from(firstLine);
	if (chars.length <= ISSUE_TITLE_MAX_CHARS) {
		return firstLine;
	}
	return `${chars.slice(0, ISSUE_TITLE_MAX_CHARS).join("")}…`;
}

/** Body sent with a GitHub issue: the raw feedback + an environment footer. */
export function buildIssueBody(input: string, env: EnvironmentInfo): string {
	return [
		input.trim(),
		"",
		"---",
		"",
		"**Environment**",
		`- OS: ${env.os}`,
		`- Helmor version: ${env.appVersion}`,
	].join("\n");
}

/**
 * Default prompt template sent to the agent when a user picks "Quick fix".
 * Embeds the user's feedback plus environment info so the agent has all the
 * context it needs to get started without a back-and-forth.
 */
export function buildPromptTemplate(
	input: string,
	env: EnvironmentInfo,
): string {
	return [
		"I'd like to contribute an improvement to Helmor.",
		"",
		"## My feedback",
		input.trim(),
		"",
		"## Environment",
		`- OS: ${env.os}`,
		`- Helmor version: ${env.appVersion}`,
		"",
		"## How you can help",
		"Please:",
		"1. Explore the relevant code to understand current behavior.",
		"2. Ask clarifying questions if anything is ambiguous.",
		"3. Propose a minimal, surgical change.",
		"4. Implement it once we agree on the approach.",
	].join("\n");
}

/**
 * Reference prompt the user can copy at the end of the wizard. Tells the
 * agent to commit + push + open a PR to the helmor upstream once the user is
 * happy with the fix.
 */
export function buildPrHint(): string {
	return [
		"When the agent finishes the fix, paste this back:",
		"",
		"Please commit the change with a clear message, push the branch to",
		"origin, then run the following to open a PR:",
		"",
		`  gh pr create --repo ${HELMOR_UPSTREAM_SLUG} --base main`,
		"",
		"Generate a descriptive title and body based on what changed. If `gh`",
		"is not installed, push the branch and give me the compare URL so I",
		"can open the PR manually.",
	].join("\n");
}

/**
 * Detect the user's OS from `navigator.userAgent`. Runs client-side only.
 * We use a coarse label because the agent doesn't need more than that.
 */
export function detectOsLabel(): string {
	if (typeof navigator === "undefined") {
		return "Unknown";
	}
	const ua = navigator.userAgent;
	if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
	if (/Windows/i.test(ua)) return "Windows";
	if (/Linux/i.test(ua)) return "Linux";
	return ua;
}

/**
 * Build a minimal Lexical SerializedEditorState wrapping a single plain-text
 * paragraph. Saved to the composer's localStorage slot so the workspace
 * composer picks it up on mount as a pre-filled draft — letting the user
 * review the prompt in context and press Send themselves.
 *
 * This shape is the canonical Lexical output for a text-only paragraph; it
 * parses cleanly through `editor.parseEditorState()`.
 */
export function buildPlainTextEditorState(text: string): SerializedEditorState {
	return {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: "ltr",
			children: [
				{
					type: "paragraph",
					version: 1,
					format: "",
					indent: 0,
					direction: "ltr",
					textFormat: 0,
					textStyle: "",
					children: text
						? [
								{
									type: "text",
									version: 1,
									format: 0,
									mode: "normal",
									style: "",
									text,
									detail: 0,
								},
							]
						: [],
				},
			],
		},
	} as unknown as SerializedEditorState;
}
