/**
 * Manages active Codex SDK sessions.
 *
 * Mirrors the Claude SessionManager pattern: each session wraps a
 * Codex Thread that streams ThreadEvents back to the caller.
 */

import {
	Codex,
	type Input,
	type ThreadOptions,
	type UserInput,
} from "@openai/codex-sdk";

type EmitFn = (data: Record<string, unknown>) => void;

/** Regex matching @/absolute/path.ext image references in a prompt. */
const IMAGE_REF_RE = /@(\/\S+\.(?:png|jpe?g|gif|webp|svg|bmp|ico))/gi;

/**
 * Parse a prompt string, extract image refs, and return Codex Input.
 * If images found, returns UserInput[] with text + local_image entries;
 * otherwise returns the original string.
 */
function buildCodexInput(prompt: string): Input {
	const imagePaths: string[] = [];
	IMAGE_REF_RE.lastIndex = 0;
	for (
		let match = IMAGE_REF_RE.exec(prompt);
		match !== null;
		match = IMAGE_REF_RE.exec(prompt)
	) {
		imagePaths.push(match[1]);
	}
	if (imagePaths.length === 0) {
		return prompt;
	}
	let text = prompt;
	for (const p of imagePaths) {
		text = text.replace(`@${p}`, "");
	}
	text = text.replace(/ {2,}/g, " ").trim();

	const parts: UserInput[] = [];
	if (text) {
		parts.push({ type: "text", text });
	}
	for (const p of [...new Set(imagePaths)]) {
		parts.push({ type: "local_image", path: p });
	}
	return parts;
}

export class CodexSessionManager {
	private abortControllers = new Map<string, AbortController>();

	/**
	 * Send a message in a Codex session.
	 * Creates a new thread or resumes an existing one, then streams events.
	 */
	async sendMessage(
		requestId: string,
		params: {
			sessionId: string;
			prompt: string;
			model?: string;
			cwd?: string;
			resume?: string;
			effortLevel?: string;
			permissionMode?: string;
		},
		emit: EmitFn,
	): Promise<void> {
		const {
			sessionId,
			prompt,
			model,
			cwd,
			resume,
			effortLevel,
			permissionMode,
		} = params;

		const abortController = new AbortController();
		this.abortControllers.set(sessionId, abortController);

		try {
			const codex = new Codex();

			// model and workingDirectory belong on ThreadOptions, not TurnOptions
			const threadOpts: ThreadOptions = {
				...(model ? { model } : {}),
				...(cwd ? { workingDirectory: cwd } : {}),
				skipGitRepoCheck: true,
				...(effortLevel
					? {
							modelReasoningEffort: effortLevel as
								| "minimal"
								| "low"
								| "medium"
								| "high"
								| "xhigh",
						}
					: {}),
				...(permissionMode === "plan"
					? { approvalPolicy: "never" as const }
					: {}),
			};

			const thread = resume
				? codex.resumeThread(resume, threadOpts)
				: codex.startThread(threadOpts);

			// Parse image references and build appropriate input
			const input = buildCodexInput(prompt);

			// runStreamed returns { events: AsyncGenerator<ThreadEvent> }
			const streamedTurn = await thread.runStreamed(input, {
				signal: abortController.signal,
			});

			let threadId: string | null = null;

			for await (const event of streamedTurn.events) {
				// Capture thread ID
				if (!threadId) {
					threadId = thread.id;
				}

				// Emit raw Codex events — Rust persistence and frontend parse them
				emit({
					id: requestId,
					...(event as unknown as Record<string, unknown>),
					...(threadId ? { sessionId: threadId } : {}),
				});
			}

			// Final thread ID
			threadId = thread.id;

			emit({
				id: requestId,
				type: "end",
				sessionId: threadId ?? sessionId,
			});
		} finally {
			this.abortControllers.delete(sessionId);
		}
	}

	/**
	 * Generate a short title + branch name for a session.
	 * Uses the cheapest/fastest model available.
	 */
	async generateTitle(
		requestId: string,
		userMessage: string,
		emit: EmitFn,
	): Promise<void> {
		const titlePrompt = [
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

		const codex = new Codex();
		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), 15_000);

		try {
			const thread = codex.startThread({
				model: "gpt-5.3-codex-spark",
			});

			const streamedTurn = await thread.runStreamed(titlePrompt, {
				signal: abortController.signal,
			});

			let resultText = "";
			for await (const event of streamedTurn.events) {
				const ev = event as unknown as Record<string, unknown>;
				if (ev.type === "item.completed") {
					const item = ev.item as Record<string, unknown> | undefined;
					if (item?.type === "agent_message" && typeof item.text === "string") {
						resultText += item.text;
					}
				}
			}

			let parsedTitle = "";
			let parsedBranch = "";
			for (const line of resultText.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.toLowerCase().startsWith("title:")) {
					parsedTitle = trimmed
						.slice(6)
						.trim()
						.replace(/^["'""'']+|["'""'']+$/g, "")
						.trim();
				} else if (trimmed.toLowerCase().startsWith("branch:")) {
					parsedBranch = trimmed
						.slice(7)
						.trim()
						.replace(/[^a-z0-9-]/g, "")
						.replace(/-+/g, "-")
						.replace(/^-|-$/g, "");
				}
			}
			if (!parsedTitle && resultText.trim()) {
				parsedTitle = resultText
					.trim()
					.replace(/^["'""'']+|["'""'']+$/g, "")
					.trim();
			}

			emit({
				id: requestId,
				type: "titleGenerated",
				title: parsedTitle,
				branchName: parsedBranch || undefined,
			});
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * Stop an active session.
	 */
	async stopSession(sessionId: string): Promise<void> {
		const controller = this.abortControllers.get(sessionId);
		if (controller) {
			controller.abort();
			this.abortControllers.delete(sessionId);
		}
	}
}
