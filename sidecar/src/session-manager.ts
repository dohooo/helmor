/**
 * Manages active Claude Agent SDK sessions.
 *
 * Each session wraps a `query()` async generator that stays alive
 * for the session's lifetime. Follow-up messages are sent via
 * the streaming input interface.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

type EmitFn = (data: Record<string, unknown>) => void;

interface LiveSession {
	query: Query;
	abortController: AbortController;
}

/** Regex matching @/absolute/path.ext image references in a prompt. */
const IMAGE_REF_RE = /@(\/\S+\.(?:png|jpe?g|gif|webp|svg|bmp|ico))/gi;

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function extToMediaType(filePath: string): MediaType {
	const ext = extname(filePath).toLowerCase();
	switch (ext) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

/**
 * Parse a prompt string and extract inline image references.
 * Returns the cleaned text (without @/path refs) and the image paths.
 */
function parseImageRefsFromPrompt(prompt: string): {
	text: string;
	imagePaths: string[];
} {
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
		return { text: prompt, imagePaths: [] };
	}
	let text = prompt;
	for (const p of imagePaths) {
		text = text.replace(`@${p}`, "");
	}
	text = text.replace(/ {2,}/g, " ").trim();
	return { text, imagePaths: [...new Set(imagePaths)] };
}

/**
 * Build an SDKUserMessage with text + base64 image content blocks.
 */
async function buildUserMessageWithImages(
	text: string,
	imagePaths: string[],
): Promise<SDKUserMessage> {
	const content: Array<
		| { type: "text"; text: string }
		| {
				type: "image";
				source: { type: "base64"; media_type: MediaType; data: string };
		  }
	> = [];

	if (text) {
		content.push({ type: "text", text });
	}

	for (const imgPath of imagePaths) {
		try {
			const data = await readFile(imgPath);
			const base64 = data.toString("base64");
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: extToMediaType(imgPath),
					data: base64,
				},
			});
		} catch {
			// If we can't read the image, include it as text reference
			content.push({
				type: "text",
				text: `[Image not found: ${imgPath}]`,
			});
		}
	}

	return {
		type: "user",
		message: {
			role: "user",
			content,
		},
		parent_tool_use_id: null,
	} as SDKUserMessage;
}

export class SessionManager {
	private sessions = new Map<string, LiveSession>();

	/**
	 * Send a message in a session.
	 * If resuming, uses the SDK's resume option to restore context.
	 * Streams all SDK messages to the caller via emit().
	 *
	 * Per SDK contract: sessionId and resume are mutually exclusive
	 * unless forkSession is also set. When resuming, we only pass
	 * resume (the SDK resolves the session itself).
	 */
	async sendMessage(
		requestId: string,
		params: {
			sessionId: string;
			prompt: string;
			model?: string;
			cwd?: string;
			resume?: string;
			permissionMode?: string;
			effortLevel?: string;
		},
		emit: EmitFn,
	): Promise<void> {
		const {
			sessionId,
			prompt,
			model,
			cwd,
			resume,
			permissionMode,
			effortLevel,
		} = params;

		const abortController = new AbortController();

		// sessionId and resume are mutually exclusive in the SDK contract.
		// When resuming, pass resume so the SDK loads existing context.
		// When starting fresh, let the SDK auto-generate its own session ID
		// — do NOT pass our Helmor UUID as sessionId, because the SDK's
		// internal session store may use a different ID format.
		const sessionOpts: Record<string, unknown> = {};
		if (resume) {
			sessionOpts.resume = resume;
		}
		// For new sessions: no sessionId → SDK generates its own

		// Parse image references from the prompt
		const { text, imagePaths } = parseImageRefsFromPrompt(prompt);

		// If prompt contains images, use SDKUserMessage with ImageBlockParam;
		// otherwise use plain string (simpler, preserves existing behavior).
		let promptValue: string | AsyncIterable<SDKUserMessage>;
		if (imagePaths.length > 0) {
			const userMessage = await buildUserMessageWithImages(text, imagePaths);
			promptValue = (async function* () {
				yield userMessage;
			})();
		} else {
			promptValue = prompt;
		}

		const q = query({
			prompt: promptValue,
			options: {
				abortController,
				cwd: cwd || undefined,
				model: model || undefined,
				...sessionOpts,
				permissionMode:
					(permissionMode as
						| "default"
						| "plan"
						| "bypassPermissions"
						| "acceptEdits"
						| "dontAsk"
						| "auto") || "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				effort: (effortLevel as "low" | "medium" | "high" | "max") || undefined,
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
			},
		});

		// Track the session
		this.sessions.set(sessionId, { query: q, abortController });

		try {
			let resolvedSessionId: string | undefined;

			for await (const message of q) {
				// Capture session ID — q.sessionId is an undocumented runtime property;
				// guard access since it's not on the Query type.
				if (!resolvedSessionId) {
					try {
						resolvedSessionId = (q as unknown as { sessionId?: string })
							.sessionId;
					} catch {
						// Not yet initialized
					}
				}

				emit({
					id: requestId,
					...serializeMessage(message),
					...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
				});
			}

			// Final session ID
			try {
				resolvedSessionId = (q as unknown as { sessionId?: string }).sessionId;
			} catch {
				// Ignore
			}

			emit({
				id: requestId,
				type: "end",
				sessionId: resolvedSessionId ?? sessionId,
			});
		} finally {
			this.sessions.delete(sessionId);
		}
	}

	/**
	 * Generate a short title for a session based on the user's message.
	 *
	 * Uses haiku (cheapest/fastest model) with plan mode (no tool use).
	 * Returns the generated title string via a single "titleGenerated" event.
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

		const abortController = new AbortController();
		// Auto-cancel after 15 seconds
		const timeout = setTimeout(() => abortController.abort(), 15_000);

		try {
			const q = query({
				prompt: titlePrompt,
				options: {
					abortController,
					model: "haiku",
					permissionMode: "plan",
					allowDangerouslySkipPermissions: true,
				},
			});

			let title = "";
			for await (const message of q) {
				const msg = message as unknown as Record<string, unknown>;
				// Collect text from "result" event (Claude CLI final output)
				if (msg.type === "result" && typeof msg.result === "string") {
					title = msg.result;
				}
			}

			// Parse "title: ..." and "branch: ..." from the result
			let parsedTitle = "";
			let parsedBranch = "";
			for (const line of title.split("\n")) {
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
			// Fallback: if parsing failed, use raw result as title
			if (!parsedTitle && title.trim()) {
				parsedTitle = title
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
		const session = this.sessions.get(sessionId);
		if (session) {
			session.abortController.abort();
			this.sessions.delete(sessionId);
		}
	}
}

/**
 * Convert an SDK message to a plain serializable object.
 */
function serializeMessage(message: SDKMessage): Record<string, unknown> {
	// SDKMessage is already a plain object from the SDK
	if (typeof message === "object" && message !== null) {
		return message as unknown as Record<string, unknown>;
	}
	return { type: "unknown", raw: String(message) };
}
