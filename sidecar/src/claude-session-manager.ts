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
// `@anthropic-ai/claude-agent-sdk/embed` is the SDK's bun-standalone-binary
// helper. In dev (`bun run src/index.ts`) it returns the real on-disk path
// to `cli.js` inside `node_modules`. After `bun build --compile` Bun embeds
// `cli.js` into the binary's `$bunfs` virtual FS, and the helper extracts it
// to a tmpdir at module load time so it can be spawned as a subprocess —
// child processes have no access to the parent's `$bunfs`. Without this
// the release sidecar fails every `query()` with
// "Claude Code executable not found at /$bunfs/root/cli.js".
import claudeCliPath from "@anthropic-ai/claude-agent-sdk/embed";
import { isAbortError } from "./abort.js";
import type { SidecarEmitter } from "./emitter.js";
import { parseImageRefs } from "./images.js";
import type {
	ListSlashCommandsParams,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
} from "./session-manager.js";
import {
	buildTitlePrompt,
	parseTitleAndBranch,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

/**
 * Hard upper bound on how long `listSlashCommands` will wait for the SDK's
 * control-protocol response. The slash-command popup is interactive (the user
 * just opened a dropdown), so anything longer than a few seconds is worse
 * than just showing an empty list. Without this bound, a missing or
 * unresponsive `claude-code` binary parks the request forever and the popup
 * spinner never resolves.
 */
const SLASH_COMMANDS_TIMEOUT_MS = 5_000;

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
				pathToClaudeCodeExecutable: claudeCliPath,
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
			// `abortController.abort()` alone leaves Node-level exit listeners,
			// pending control/MCP promises, and the SDK's internal child handle
			// dangling. `Query.close()` is the documented hard cleanup —
			// always call it, including on the natural-completion path so the
			// per-request `process.on("exit", ...)` listener gets removed.
			try {
				q.close();
			} catch (closeErr) {
				// Best-effort cleanup; never let this mask the original error.
				void closeErr;
			}
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

		const q = query({
			prompt: buildTitlePrompt(userMessage),
			options: {
				abortController,
				pathToClaudeCodeExecutable: claudeCliPath,
				model: "haiku",
				permissionMode: "plan",
				allowDangerouslySkipPermissions: true,
			},
		});

		try {
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
			try {
				q.close();
			} catch (closeErr) {
				void closeErr;
			}
		}
	}

	/**
	 * Fetch the list of slash commands the Claude SDK currently exposes for
	 * the given workspace. The SDK only surfaces commands via a live `Query`
	 * (control protocol), so we spin up a transient query whose prompt is a
	 * never-yielding async iterator. That keeps the underlying `claude-code`
	 * child alive long enough to answer the control request without ever
	 * sending a turn to the model — `donePromise` is resolved in `finally`
	 * which lets the iterator return naturally as part of teardown.
	 */
	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		const { cwd, model } = params;
		const abortController = new AbortController();

		let resolveDone: () => void = () => undefined;
		const donePromise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		// Streaming-input mode requires an `AsyncIterable<SDKUserMessage>`.
		// Awaiting `donePromise` here parks the iterator until teardown
		// signals it to return — it never yields a user message, so no turn
		// is ever fired. Typing the generator as `AsyncGenerator<never>` lets
		// it widen into `AsyncIterable<SDKUserMessage>` covariantly without a
		// `as unknown as` smuggle.
		const promptIter: AsyncIterable<SDKUserMessage> =
			(async function* (): AsyncGenerator<never> {
				await donePromise;
				// Unreachable in practice (donePromise resolves only on teardown,
				// after which the iterator returns), but biome's `useYield` rule
				// requires generators to contain at least one `yield` expression.
				yield* [];
			})();

		const q = query({
			prompt: promptIter,
			options: {
				abortController,
				pathToClaudeCodeExecutable: claudeCliPath,
				cwd: cwd || undefined,
				model: model || undefined,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				includePartialMessages: false,
				settingSources: ["user", "project", "local"],
			},
		});

		// Drain the message iterator in the background so the SDK's internal
		// state machine progresses past init. We don't care about any events
		// it produces — only the control-protocol response from
		// `supportedCommands()`. Errors here are intentionally swallowed;
		// the real error path is the `await` below.
		const drain = (async () => {
			try {
				for await (const _ of q) {
					void _;
				}
			} catch {
				// ignored — teardown path handles errors via the outer await
			}
		})();

		// Bound the supportedCommands() call so a missing or unresponsive
		// `claude-code` binary cannot park this promise forever. On timeout
		// we abort the controller — the SDK observes the abort signal and
		// rejects the supportedCommands() promise — and we convert the
		// resulting error into a friendly, actionable message via the
		// `timedOut` flag below.
		let timedOut = false;
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			try {
				abortController.abort();
			} catch {
				// best-effort
			}
		}, SLASH_COMMANDS_TIMEOUT_MS);

		try {
			const commands = await q.supportedCommands();
			// Dedupe by name. The SDK can return the same command twice when
			// the same skill is registered through multiple sources (e.g., a
			// plugin marketplace AND `~/.claude/skills/`). First occurrence
			// wins to match Claude Code's own popup behavior.
			const seen = new Set<string>();
			const out: SlashCommandInfo[] = [];
			for (const c of commands) {
				if (seen.has(c.name)) continue;
				seen.add(c.name);
				out.push({
					name: c.name,
					description: c.description,
					argumentHint: c.argumentHint || undefined,
					source: "builtin",
				});
			}
			return out;
		} catch (err) {
			if (timedOut) {
				throw new Error(
					`listSlashCommands timed out after ${SLASH_COMMANDS_TIMEOUT_MS}ms — claude-code may be missing or unresponsive`,
				);
			}
			throw err;
		} finally {
			clearTimeout(timeoutHandle);
			resolveDone();
			try {
				abortController.abort();
			} catch {
				// best-effort
			}
			try {
				q.close();
			} catch {
				// best-effort
			}
			await drain.catch(() => undefined);
		}
	}

	async stopSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.abortController.abort();
			this.sessions.delete(sessionId);
		}
	}

	async shutdown(): Promise<void> {
		// Snapshot first — `query.close()` triggers the finally block in
		// sendMessage which mutates `this.sessions`.
		const snapshot = Array.from(this.sessions.values());
		for (const session of snapshot) {
			try {
				session.query.close();
			} catch {
				// best-effort
			}
		}
		this.sessions.clear();
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
