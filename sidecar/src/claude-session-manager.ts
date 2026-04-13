/**
 * `SessionManager` implementation backed by the Claude Agent SDK.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname } from "node:path";
import {
	type ElicitationResult,
	type HookInput,
	type HookJSONOutput,
	type PermissionUpdate,
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbortError } from "./abort.js";
import type { SidecarEmitter } from "./emitter.js";
import { resolveGitAccessDirectories } from "./git-access.js";
import { parseImageRefs } from "./images.js";
import { logger } from "./logger.js";
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

const DEFERRED_TOOL_NAMES = new Set(["AskUserQuestion"]);

interface PermissionResolution {
	readonly behavior: "allow" | "deny";
	readonly updatedPermissions?: PermissionUpdate[];
	readonly message?: string;
}

type DeferredToolBehavior = "allow" | "deny";

interface DeferredToolResolution {
	readonly behavior: DeferredToolBehavior;
	readonly reason: string | undefined;
	readonly updatedInput: Record<string, unknown> | undefined;
	readonly createdAt: number;
}

const DEFERRED_TOOL_RESPONSE_TTL_MS = 5 * 60 * 1000;

function parsePermissionMode(value: string | undefined): ClaudePermissionMode {
	if (
		value !== undefined &&
		(VALID_PERMISSION_MODES as readonly string[]).includes(value)
	) {
		return value as ClaudePermissionMode;
	}
	return "bypassPermissions";
}

function extractSessionPermissionMode(
	updates: readonly PermissionUpdate[] | undefined,
): ClaudePermissionMode | undefined {
	if (!updates) {
		return undefined;
	}

	for (const update of updates) {
		if (typeof update !== "object" || update === null) {
			continue;
		}

		const candidate = update as {
			type?: unknown;
			destination?: unknown;
			mode?: unknown;
		};
		if (
			candidate.type === "setMode" &&
			candidate.destination === "session" &&
			typeof candidate.mode === "string" &&
			(VALID_PERMISSION_MODES as readonly string[]).includes(candidate.mode)
		) {
			return candidate.mode as ClaudePermissionMode;
		}
	}

	return undefined;
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
		(resolution: PermissionResolution) => void
	>();
	private readonly pendingElicitations = new Map<
		string,
		(result: ElicitationResult) => void
	>();
	private readonly deferredToolResponses = new Map<
		string,
		DeferredToolResolution
	>();

	private pruneExpiredDeferredToolResponses(now = Date.now()): void {
		for (const [toolUseId, resolution] of this.deferredToolResponses) {
			if (now - resolution.createdAt > DEFERRED_TOOL_RESPONSE_TTL_MS) {
				this.deferredToolResponses.delete(toolUseId);
			}
		}
	}

	resolvePermission(
		permissionId: string,
		behavior: "allow" | "deny",
		updatedPermissions?: PermissionUpdate[],
		message?: string,
	): void {
		const resolve = this.pendingPermissions.get(permissionId);
		if (resolve) {
			this.pendingPermissions.delete(permissionId);
			resolve({ behavior, updatedPermissions, message });
		}
	}

	resolveElicitation(elicitationId: string, result: ElicitationResult): void {
		const resolve = this.pendingElicitations.get(elicitationId);
		if (resolve) {
			this.pendingElicitations.delete(elicitationId);
			resolve(result);
		}
	}

	resolveDeferredTool(
		toolUseId: string,
		behavior: DeferredToolBehavior,
		reason: string | undefined,
		updatedInput: Record<string, unknown> | undefined,
	): void {
		this.pruneExpiredDeferredToolResponses();
		this.deferredToolResponses.set(toolUseId, {
			behavior,
			reason,
			updatedInput,
			createdAt: Date.now(),
		});
	}

	private async handleDeferredToolHook(
		input: HookInput,
		toolUseID: string | undefined,
	): Promise<HookJSONOutput> {
		if (input.hook_event_name !== "PreToolUse") {
			return {};
		}
		if (!toolUseID || !DEFERRED_TOOL_NAMES.has(input.tool_name)) {
			return {};
		}
		this.pruneExpiredDeferredToolResponses();
		const resolved = this.deferredToolResponses.get(toolUseID);
		if (resolved) {
			return {
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: resolved.behavior,
					...(resolved.reason
						? { permissionDecisionReason: resolved.reason }
						: {}),
					...(resolved.updatedInput
						? { updatedInput: resolved.updatedInput }
						: {}),
				},
			};
		}
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "defer",
			},
		};
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
		const additionalDirectories = await resolveGitAccessDirectories(cwd);

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
				...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
				model: model || undefined,
				...(resume ? { resume } : {}),
				permissionMode: parsePermissionMode(permissionMode),
				allowDangerouslySkipPermissions: true,
				effort: parseEffort(effortLevel),
				hooks: {
					PreToolUse: [
						{
							hooks: [
								async (input, toolUseID) =>
									this.handleDeferredToolHook(input, toolUseID),
							],
						},
					],
				},
				onElicitation: async (request, options) => {
					const elicitationId = request.elicitationId ?? randomUUID();
					emitter.elicitationRequest(
						requestId,
						request.serverName,
						request.message,
						request.mode,
						request.url,
						elicitationId,
						request.requestedSchema as Record<string, unknown> | undefined,
					);
					return await new Promise<ElicitationResult>((resolve) => {
						this.pendingElicitations.set(elicitationId, resolve);
						options.signal.addEventListener(
							"abort",
							() => {
								this.pendingElicitations.delete(elicitationId);
								resolve({ action: "cancel" });
							},
							{ once: true },
						);
					});
				},
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
				canUseTool: async (_toolName, input, options) => {
					if (DEFERRED_TOOL_NAMES.has(_toolName)) {
						return {
							behavior: "allow" as const,
							updatedInput: input,
						};
					}
					// Intercept ExitPlanMode: capture plan content and deny to
					// end the turn cleanly. The user starts a new turn to act.
					if (_toolName === "ExitPlanMode") {
						const plan =
							typeof input?.plan === "string" && input.plan.trim()
								? input.plan
								: null;
						if (plan) {
							emitter.planCaptured(requestId, options.toolUseID, plan);
						}
						return {
							behavior: "deny" as const,
							message:
								"Plan captured by the client. " +
								"Do NOT continue generating text or call any tools. " +
								"The turn is over. The user will respond in a new turn.",
						};
					}
					const permissionId = options.toolUseID;
					emitter.permissionRequest(
						requestId,
						permissionId,
						_toolName,
						input,
						options.title,
						options.description,
					);
					const resolution = await new Promise<PermissionResolution>(
						(resolve) => {
							this.pendingPermissions.set(permissionId, resolve);
							options.signal.addEventListener(
								"abort",
								() => {
									this.pendingPermissions.delete(permissionId);
									resolve({ behavior: "deny" });
								},
								{ once: true },
							);
						},
					);
					if (resolution.behavior === "allow") {
						const updatedPermissions =
							resolution.updatedPermissions ?? options.suggestions;
						const nextPermissionMode =
							extractSessionPermissionMode(updatedPermissions);
						if (nextPermissionMode) {
							emitter.permissionModeChanged(requestId, nextPermissionMode);
						}

						return {
							behavior: "allow" as const,
							updatedInput: input,
							updatedPermissions,
						};
					}
					return {
						behavior: "deny" as const,
						message: resolution.message ?? "User denied",
					};
				},
			},
		});

		this.sessions.set(sessionId, { query: q, abortController });

		try {
			for await (const message of q) {
				logger.sdkEvent(requestId, message);
				if (isDeferredToolResult(message)) {
					emitter.deferredToolUse(
						requestId,
						message.deferred_tool_use.id,
						message.deferred_tool_use.name,
						message.deferred_tool_use.input,
					);
					continue;
				}
				const passthroughMessage = stripDeferredToolUseFromAssistant(message);
				if (passthroughMessage) {
					emitter.passthrough(requestId, passthroughMessage);
				}
				if (isTerminalSuccessResult(message)) {
					emitter.end(requestId);
					return;
				}
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
			for (const [elicitationId, resolve] of this.pendingElicitations) {
				this.pendingElicitations.delete(elicitationId);
				resolve({ action: "cancel" });
			}
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
		for (const [elicitationId, resolve] of this.pendingElicitations) {
			this.pendingElicitations.delete(elicitationId);
			resolve({ action: "cancel" });
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

function isDeferredToolResult(message: SDKMessage): message is SDKMessage & {
	type: "result";
	deferred_tool_use: {
		id: string;
		name: string;
		input: Record<string, unknown>;
	};
} {
	if (message.type !== "result") return false;
	if (!("deferred_tool_use" in message)) return false;
	const deferred = (message as { deferred_tool_use?: unknown })
		.deferred_tool_use;
	if (typeof deferred !== "object" || deferred === null) return false;
	const value = deferred as { id?: unknown; name?: unknown; input?: unknown };
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.input === "object" &&
		value.input !== null
	);
}

function isTerminalSuccessResult(message: SDKMessage): boolean {
	if (message.type !== "result") {
		return false;
	}
	if (isDeferredToolResult(message)) {
		return false;
	}
	return (message as { is_error?: boolean }).is_error !== true;
}

function stripDeferredToolUseFromAssistant(message: SDKMessage): object | null {
	if (message.type !== "assistant") {
		return message;
	}
	if (!("message" in message)) {
		return message;
	}

	const assistantMessage = (message as { message?: unknown }).message;
	if (typeof assistantMessage !== "object" || assistantMessage === null) {
		return message;
	}

	const content = (assistantMessage as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return message;
	}

	let removedDeferredTool = false;
	const filteredContent = content.filter((block) => {
		if (!isDeferredToolUseBlock(block)) {
			return true;
		}
		removedDeferredTool = true;
		return false;
	});

	if (!removedDeferredTool) {
		return message;
	}
	if (filteredContent.length === 0) {
		return null;
	}

	return {
		...(message as Record<string, unknown>),
		message: {
			...(assistantMessage as Record<string, unknown>),
			content: filteredContent,
		},
	};
}

function isDeferredToolUseBlock(block: unknown): boolean {
	if (typeof block !== "object" || block === null) {
		return false;
	}

	const value = block as { type?: unknown; name?: unknown };
	return (
		value.type === "tool_use" &&
		typeof value.name === "string" &&
		DEFERRED_TOOL_NAMES.has(value.name)
	);
}
