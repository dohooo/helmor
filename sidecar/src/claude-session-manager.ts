/**
 * `SessionManager` implementation backed by the Claude Agent SDK.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbortError } from "./abort.js";
import type { SidecarEmitter } from "./emitter.js";
import { parseImageRefs } from "./images.js";
import type { SendMessageParams, SessionManager } from "./session-manager.js";
import {
	buildTitlePrompt,
	parseTitleAndBranch,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

interface LiveSession {
	readonly query: Query;
	readonly abortController: AbortController;
}

const VALID_PERMISSION_MODES = [
	"default",
	"plan",
	"bypassPermissions",
	"acceptEdits",
	"dontAsk",
	"auto",
] as const;
type ClaudePermissionMode = (typeof VALID_PERMISSION_MODES)[number];

const VALID_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
type ClaudeEffort = (typeof VALID_EFFORT_LEVELS)[number];

function parsePermissionMode(value: string | undefined): ClaudePermissionMode {
	if (
		value !== undefined &&
		(VALID_PERMISSION_MODES as readonly string[]).includes(value)
	) {
		return value as ClaudePermissionMode;
	}
	return "bypassPermissions";
}

function parseEffort(value: string | undefined): ClaudeEffort | undefined {
	if (value && (VALID_EFFORT_LEVELS as readonly string[]).includes(value)) {
		return value as ClaudeEffort;
	}
	return undefined;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function extToMediaType(filePath: string): ImageMediaType {
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

type ContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: { type: "base64"; media_type: ImageMediaType; data: string };
	  };

async function buildUserMessageWithImages(
	text: string,
	imagePaths: readonly string[],
): Promise<SDKUserMessage> {
	const content: ContentBlock[] = [];

	if (text) {
		content.push({ type: "text", text });
	}

	for (const imgPath of imagePaths) {
		try {
			const data = await readFile(imgPath);
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: extToMediaType(imgPath),
					data: data.toString("base64"),
				},
			});
		} catch {
			content.push({ type: "text", text: `[Image not found: ${imgPath}]` });
		}
	}

	return {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
	} as SDKUserMessage;
}

export class ClaudeSessionManager implements SessionManager {
	private readonly sessions = new Map<string, LiveSession>();

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
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

		const { text, imagePaths } = parseImageRefs(prompt);
		const promptValue: string | AsyncIterable<SDKUserMessage> =
			imagePaths.length === 0
				? prompt
				: (async function* () {
						yield await buildUserMessageWithImages(text, imagePaths);
					})();

		const q = query({
			prompt: promptValue,
			options: {
				abortController,
				cwd: cwd || undefined,
				model: model || undefined,
				...(resume ? { resume } : {}),
				permissionMode: parsePermissionMode(permissionMode),
				allowDangerouslySkipPermissions: true,
				effort: parseEffort(effortLevel),
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
			},
		});

		this.sessions.set(sessionId, { query: q, abortController });

		try {
			for await (const message of q) {
				emitter.passthrough(requestId, message);
			}
			emitter.end(requestId);
		} catch (err) {
			if (isAbortError(err)) {
				emitter.aborted(requestId, "user_requested");
				return;
			}
			throw err;
		} finally {
			this.sessions.delete(sessionId);
		}
	}

	async generateTitle(
		requestId: string,
		userMessage: string,
		emitter: SidecarEmitter,
	): Promise<void> {
		const abortController = new AbortController();
		const timeout = setTimeout(
			() => abortController.abort(),
			TITLE_GENERATION_TIMEOUT_MS,
		);

		try {
			const q = query({
				prompt: buildTitlePrompt(userMessage),
				options: {
					abortController,
					model: "haiku",
					permissionMode: "plan",
					allowDangerouslySkipPermissions: true,
				},
			});

			let raw = "";
			for await (const message of q) {
				if (isResultMessage(message)) {
					raw = message.result;
				}
			}

			const { title, branchName } = parseTitleAndBranch(raw);
			emitter.titleGenerated(requestId, title, branchName);
		} finally {
			clearTimeout(timeout);
		}
	}

	async stopSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.abortController.abort();
			this.sessions.delete(sessionId);
		}
	}
}

function isResultMessage(
	message: SDKMessage,
): message is SDKMessage & { type: "result"; result: string } {
	return (
		message.type === "result" &&
		"result" in message &&
		typeof (message as { result?: unknown }).result === "string"
	);
}
