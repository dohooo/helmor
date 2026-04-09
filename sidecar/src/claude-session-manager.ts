/**
 * `SessionManager` implementation backed by the Claude Agent SDK.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
 *
 * 8s gives a cold-start `claude-code` child enough room to bind without
 * making the user wait noticeably long. The frontend retries twice on top
 * of this with backoff, so a transient hiccup self-recovers.
 */
const SLASH_COMMANDS_TIMEOUT_MS = 8_000;

/**
 * Resolve the path to `@anthropic-ai/claude-code`'s `cli.js`, used as the
 * explicit `pathToClaudeCodeExecutable` for every SDK `query()` call.
 *
 * Resolution order:
 *   1. `HELMOR_CLAUDE_CODE_CLI_PATH` — set by the Tauri host process in
 *      release builds, pointing at the bundled resource copy inside
 *      `Helmor.app/Contents/Resources/vendor/claude-code/cli.js`.
 *   2. `createRequire` lookup against `node_modules` — used in dev
 *      (`bun run src/index.ts`) and in `bun test`, where `@anthropic-ai/
 *      claude-code` is a direct sidecar dep.
 *
 * We never fall back to the SDK's bundled cli.js: that version is pinned
 * to whatever `@anthropic-ai/claude-agent-sdk` shipped and can drift from
 * what we ship via `sidecar/dist/vendor/`. Failing loudly here surfaces
 * install-state problems at sidecar startup instead of mid-conversation.
 */
function resolveClaudeCliPath(): string {
	const override = process.env.HELMOR_CLAUDE_CODE_CLI_PATH;
	if (override) {
		return override;
	}
	const require = createRequire(import.meta.url);
	return require.resolve("@anthropic-ai/claude-code/cli.js");
}

const CLAUDE_CLI_PATH = resolveClaudeCliPath();

/**
 * Optional absolute path to a bundled `bun` binary, used as the SDK's
 * `executable` option when set.
 *
 * Background: the Claude Agent SDK spawns `cli.js` through a JS interpreter
 * (`bun` or `node`) resolved off `PATH`. Inside a Finder-launched `.app`
 * bundle, `PATH = /usr/bin:/bin:/usr/sbin:/sbin` — neither `bun` nor `node`
 * are there, so the spawn fails with ENOENT and the SDK misreports it as
 * "Claude Code executable not found at …/cli.js". To fix this for release
 * builds, Tauri stages the host's bun binary under `vendor/bun/bun` and
 * `lib.rs` exports `HELMOR_BUN_PATH` before spawning us.
 *
 * Dev mode leaves the env unset — `bun run src/index.ts` is already running
 * under a bun instance that's on the developer's PATH, so the SDK's default
 * `"bun"` lookup succeeds.
 */
const CLAUDE_EXECUTABLE_OVERRIDE = process.env.HELMOR_BUN_PATH || undefined;

/**
 * Build the `executable` / `executableArgs` half of a query() options bag.
 * Returned as a plain object so callers can spread it inline and the SDK's
 * type narrowing still applies. The `as "bun"` cast is deliberate: at
 * runtime the SDK passes `executable` straight to `child_process.spawn`,
 * which accepts absolute paths — but the TS declaration narrows it to the
 * literal `"bun" | "deno" | "node"`. See `sdk.d.ts` line 987.
 */
function executableOptions(): {
	executable?: "bun" | "deno" | "node";
} {
	if (!CLAUDE_EXECUTABLE_OVERRIDE) return {};
	return { executable: CLAUDE_EXECUTABLE_OVERRIDE as "bun" };
}

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
	private readonly pendingPermissions = new Map<
		string,
		(behavior: "allow" | "deny") => void
	>();

	resolvePermission(permissionId: string, behavior: "allow" | "deny"): void {
		const resolve = this.pendingPermissions.get(permissionId);
		if (resolve) {
			this.pendingPermissions.delete(permissionId);
			resolve(behavior);
		}
	}

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
				pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
				...executableOptions(),
				cwd: cwd || undefined,
				model: model || undefined,
				...(resume ? { resume } : {}),
				permissionMode: parsePermissionMode(permissionMode),
				allowDangerouslySkipPermissions: true,
				effort: parseEffort(effortLevel),
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
				canUseTool: async (_toolName, input, options) => {
					const permissionId = options.toolUseID;
					emitter.permissionRequest(
						requestId,
						permissionId,
						_toolName,
						input,
						options.title,
						options.description,
					);
					const behavior = await new Promise<"allow" | "deny">((resolve) => {
						this.pendingPermissions.set(permissionId, resolve);
						options.signal.addEventListener(
							"abort",
							() => {
								this.pendingPermissions.delete(permissionId);
								resolve("deny");
							},
							{ once: true },
						);
					});
					if (behavior === "allow") {
						return {
							behavior: "allow" as const,
							updatedInput: input,
							updatedPermissions: options.suggestions,
						};
					}
					return { behavior: "deny" as const, message: "User denied" };
				},
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
				pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
				...executableOptions(),
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
				pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
				...executableOptions(),
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
