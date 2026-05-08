/**
 * `SessionManager` implementation backed by the Claude Agent SDK.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import {
	type ElicitationResult,
	type PermissionUpdate,
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbortError, isQueryClosedTransient } from "./abort.js";
import { loadProjectMcpServers } from "./claude-project-mcp.js";
import { buildClaudeRichMeta, buildClaudeStoredMeta } from "./context-usage.js";
import type { SidecarEmitter, UserInputPayload } from "./emitter.js";
import { readImageWithResize } from "./image-resize.js";
import { parseImageRefs } from "./images.js";
import { prependLinkedDirectoriesContext } from "./linked-directories-context.js";
import { errorDetails, logger } from "./logger.js";
import { listProviderModels, modelSupportsFastMode } from "./model-catalog.js";
import { createPushable, type Pushable } from "./pushable-iterable.js";
import type {
	GenerateTitleOptions,
	GetContextUsageParams,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
	UserInputResolution,
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
const SLASH_COMMANDS_TIMEOUT_MS = 20_000;

/**
 * Hover popover fires this as an ad-hoc RPC. 30s is generous — the
 * control-protocol call usually returns in <300ms, but the slow-path
 * spawns a transient CLI child whose init can take seconds on a cold
 * workspace. Aborting returns an error the UI surfaces as "no data yet".
 */
const CONTEXT_USAGE_TIMEOUT_MS = 30_000;

/**
 * Resolve the Claude Code native binary for `pathToClaudeCodeExecutable`.
 * Prefers `HELMOR_CLAUDE_CODE_BIN_PATH` (release), then the platform
 * sub-package (dev/test); falls back to the wrapper bin for `--omit=optional`.
 * Mirrors the codex resolver in `codex-app-server-manager.ts`.
 */
function resolveClaudeBinPath(): string {
	const override = process.env.HELMOR_CLAUDE_CODE_BIN_PATH;
	if (override) {
		return override;
	}
	const require = createRequire(import.meta.url);
	const binName = process.platform === "win32" ? "claude.exe" : "claude";
	const platformPkg = `@anthropic-ai/claude-code-${claudePlatformShort()}`;
	try {
		const pkgJson = require.resolve(`${platformPkg}/package.json`);
		return join(dirname(pkgJson), binName);
	} catch {
		const pkgJson = require.resolve("@anthropic-ai/claude-code/package.json");
		return join(dirname(pkgJson), "bin", "claude.exe");
	}
}

function claudePlatformShort(): string {
	const arch = process.arch === "x64" ? "x64" : "arm64";
	if (process.platform === "darwin") return `darwin-${arch}`;
	if (process.platform === "win32") return `win32-${arch}`;
	if (process.platform === "linux") {
		// claude-code ships separate -musl variants; glibcVersionRuntime is absent on musl.
		const report =
			typeof process.report?.getReport === "function"
				? (process.report.getReport() as {
						header?: { glibcVersionRuntime?: string };
					})
				: null;
		const musl = !!report && report.header?.glibcVersionRuntime === undefined;
		return `linux-${arch}${musl ? "-musl" : ""}`;
	}
	return `${process.platform}-${arch}`;
}

const CLAUDE_BIN_PATH = resolveClaudeBinPath();

// SDK's `env` option REPLACES process.env when set (per its docstring:
// "Defaults to process.env"). Without spreading process.env back in, the
// spawned claude-code child loses HOME / PATH / cached OAuth creds and
// reports "Not logged in". Returns undefined when no overrides are
// supplied so the SDK keeps its default-process.env path.
function mergeQueryEnv(
	...overrides: (Record<string, string> | undefined)[]
): { [key: string]: string | undefined } | undefined {
	const present = overrides.filter(
		(o): o is Record<string, string> => o !== undefined,
	);
	if (present.length === 0) return undefined;
	return Object.assign({}, process.env, ...present);
}

interface LiveSession {
	readonly query: Query;
	readonly abortController: AbortController;
	/**
	 * Streaming-input source. The initial prompt is pushed up front in
	 * `sendMessage`; each `steer()` call pushes one more user message.
	 * The SDK folds every pushed message into ONE extended turn and
	 * emits a SINGLE terminal `result` when the whole trajectory is
	 * done — verified empirically (steer mid-stream yields one merged
	 * assistant message and one result, not per-push results). The
	 * for-await loop therefore bails on the first result it sees.
	 */
	readonly promptSource: Pushable<SDKUserMessage>;
	/** Request id owning this session; needed by `steer()` to synthesize
	 *  a user passthrough event for the active stream. */
	readonly requestId: string;
	/** Emitter bound to the active stream — used by `steer()` to fan a
	 *  synthetic user event to the pipeline so the UI renders the mid-turn
	 *  bubble at the correct position instead of tacking it onto the end. */
	readonly emitter: SidecarEmitter;
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

const VALID_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeEffort = (typeof VALID_EFFORT_LEVELS)[number];

/**
 * Tools that require interactive user input mid-execution. They go
 * through the unified `userInputRequest` UI flow instead of being
 * auto-approved by `canUseTool`.
 */
const USER_INPUT_TOOL_NAMES = new Set(["AskUserQuestion"]);

/**
 * MCP elicitation `content` must be a flat object whose values are
 * `string | number | boolean | string[]` (per the MCP 2025-11 spec).
 * Returns the input unchanged if valid, `null` otherwise.
 */
function validateMcpElicitationContent(
	content: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
	if (!content) return {};
	for (const value of Object.values(content)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			continue;
		}
		if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
			continue;
		}
		return null;
	}
	return content;
}

interface PermissionResolution {
	readonly behavior: "allow" | "deny";
	readonly updatedPermissions?: PermissionUpdate[];
	readonly message?: string;
}

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
			const { buffer } = await readImageWithResize(imgPath);
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: extToMediaType(imgPath),
					data: buffer.toString("base64"),
				},
			});
		} catch (err) {
			logger.error("Failed to read image attachment", {
				imageName: basename(imgPath),
				...errorDetails(err),
			});
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
	/**
	 * In-flight callbacks waiting on the user's answer to a unified
	 * `userInputRequest` (covers both AskUserQuestion via `canUseTool`
	 * and MCP `onElicitation`). Resolving runs the closure stored at
	 * emit-time, which encapsulates the SDK-specific conversion from
	 * the generic `UserInputResolution` shape back into either an AUQ
	 * `updatedInput` or an `ElicitationResult`. Keyed by
	 * `userInputId` (the wire-level round-trip key — same as the
	 * tool_use_id for AUQ and the elicitationId for MCP).
	 */
	private readonly pendingUserInputs = new Map<
		string,
		{ sessionId: string; resolve: (resolution: UserInputResolution) => void }
	>();

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

	resolveUserInput(
		userInputId: string,
		resolution: UserInputResolution,
	): boolean {
		const entry = this.pendingUserInputs.get(userInputId);
		if (!entry) return false;
		this.pendingUserInputs.delete(userInputId);
		entry.resolve(resolution);
		return true;
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
			fastMode,
			claudeEnvironment,
			images,
			sourceRepoPath,
		} = params;
		const abortController = new AbortController();
		const additionalDirectories = [...(params.additionalDirectories ?? [])];
		logger.info(`[${requestId}] claude additionalDirectories resolved`, {
			directories: additionalDirectories,
			cwd: cwd ?? "(none)",
		});
		const promptWithContext = prependLinkedDirectoriesContext(
			prompt,
			additionalDirectories,
		);

		const { text, imagePaths } = parseImageRefs(promptWithContext, images);
		const promptSource = createPushable<SDKUserMessage>();
		const initialMessage =
			imagePaths.length === 0
				? ({
						type: "user",
						message: { role: "user", content: text },
						parent_tool_use_id: null,
					} as SDKUserMessage)
				: await buildUserMessageWithImages(text, imagePaths);
		promptSource.push(initialMessage);

		const effectiveFastMode =
			fastMode === true && modelSupportsFastMode("claude", model);
		const claudeEnv =
			claudeEnvironment && Object.keys(claudeEnvironment).length > 0
				? claudeEnvironment
				: undefined;
		const additionalDirectoryEnv =
			additionalDirectories.length > 0
				? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" }
				: undefined;
		const queryEnv = mergeQueryEnv(claudeEnv, additionalDirectoryEnv);
		const projectMcpServers = loadProjectMcpServers(sourceRepoPath);
		if (projectMcpServers) {
			logger.info(`[${requestId}] claude project MCPs injected`, {
				sourceRepoPath,
				servers: Object.keys(projectMcpServers),
			});
		}

		const q = query({
			prompt: promptSource,
			options: {
				abortController,
				pathToClaudeCodeExecutable: CLAUDE_BIN_PATH,
				cwd: cwd || undefined,
				...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
				...(queryEnv ? { env: queryEnv } : {}),
				model: model || undefined,
				...(resume ? { resume } : {}),
				permissionMode: parsePermissionMode(permissionMode),
				allowDangerouslySkipPermissions: true,
				effort: parseEffort(effortLevel),
				thinking: { type: "adaptive", display: "summarized" },
				...(effectiveFastMode ? { settings: { fastMode: true } } : {}),
				...(projectMcpServers ? { mcpServers: projectMcpServers } : {}),
				onElicitation: async (request, options) => {
					// MCP elicitation: surface as a unified userInputRequest
					// with `kind: "form"` (schema-driven) or `kind: "url"`
					// (URL launcher). The frontend's existing form / URL
					// renderers handle both shapes verbatim. The generic
					// `UserInputResolution` we get back maps 1:1 onto the
					// SDK's `ElicitationResult` shape.
					const elicitationId = request.elicitationId ?? randomUUID();
					const isUrl = request.mode === "url";
					const payload: UserInputPayload = isUrl
						? { kind: "url", url: request.url ?? "" }
						: {
								kind: "form",
								schema:
									(request.requestedSchema as
										| Record<string, unknown>
										| undefined) ?? {},
							};
					emitter.userInputRequest(
						requestId,
						elicitationId,
						request.serverName,
						request.message,
						payload,
					);
					const resolution = await new Promise<UserInputResolution>(
						(resolve) => {
							this.pendingUserInputs.set(elicitationId, {
								sessionId,
								resolve,
							});
							options.signal.addEventListener(
								"abort",
								() => {
									this.pendingUserInputs.delete(elicitationId);
									resolve({ action: "cancel" });
								},
								{ once: true },
							);
						},
					);
					if (resolution.action === "submit") {
						// MCP elicitation requires field values be primitives
						// (`string | number | boolean | string[]`). Validate
						// before handing off — a non-primitive would otherwise
						// surface as an opaque SDK error far from the cause.
						const validated = validateMcpElicitationContent(resolution.content);
						if (validated === null) {
							logger.error(
								`[${requestId}] MCP elicitation content rejected (non-primitive)`,
								{ elicitationId },
							);
							return { action: "cancel" };
						}
						return {
							action: "accept",
							content: validated as unknown as ElicitationResult extends {
								content?: infer C;
							}
								? C
								: never,
						};
					}
					if (resolution.action === "decline") {
						return { action: "decline" };
					}
					return { action: "cancel" };
				},
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
				canUseTool: async (_toolName, input, options) => {
					// AskUserQuestion: pause this `canUseTool` callback on the
					// same live `query()`, surface the question through the
					// unified `userInputRequest` flow (form mode with a
					// synthesized JSON Schema), then return the user's answer
					// via `updatedInput` so the SDK executes the tool normally.
					// No `--resume`, no extra process (issue #397 / #402).
					if (USER_INPUT_TOOL_NAMES.has(_toolName)) {
						const toolUseId = options.toolUseID;
						const auqInput = input as Record<string, unknown>;
						const rawQuestions = Array.isArray(auqInput.questions)
							? (auqInput.questions as Array<Record<string, unknown>>)
							: [];
						const metadata =
							typeof auqInput.metadata === "object" &&
							auqInput.metadata !== null &&
							!Array.isArray(auqInput.metadata)
								? (auqInput.metadata as Record<string, unknown>)
								: undefined;
						emitter.userInputRequest(
							requestId,
							toolUseId,
							"Claude",
							"Claude is asking for your input.",
							{
								kind: "ask-user-question",
								questions: rawQuestions,
								...(metadata ? { metadata } : {}),
							},
						);
						const resolution = await new Promise<UserInputResolution>(
							(resolve) => {
								this.pendingUserInputs.set(toolUseId, {
									sessionId,
									resolve,
								});
								options.signal.addEventListener(
									"abort",
									() => {
										this.pendingUserInputs.delete(toolUseId);
										resolve({ action: "cancel" });
									},
									{ once: true },
								);
							},
						);
						if (resolution.action === "submit") {
							// The frontend AUQ renderer produces the full
							// `updatedInput` shape directly (questions +
							// answers + annotations), matching what the SDK
							// expects — no conversion needed here.
							return {
								behavior: "allow" as const,
								updatedInput: resolution.content,
							};
						}
						return {
							behavior: "deny" as const,
							message: "User declined",
						};
					}
					// Intercept ExitPlanMode: capture plan content and deny to
					// end the turn cleanly. The user starts a new turn to act.
					if (_toolName === "ExitPlanMode") {
						const plan = extractExitPlanContent(input);
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

		this.sessions.set(sessionId, {
			query: q,
			abortController,
			promptSource,
			requestId,
			emitter,
		});

		try {
			for await (const message of q) {
				logger.sdkEvent(requestId, message);
				const passthroughMessage = stripUserInputToolUseFromAssistant(message);
				if (passthroughMessage) {
					emitter.passthrough(requestId, passthroughMessage);
				}
				if (isTerminalResult(message)) {
					// Terminal result (success OR error) — both shapes carry
					// `usage`/`modelUsage`, so both should update the ring.
					// Bail on the first one we see; any steer() still in its
					// image-load await will find `promptSource.closed` via
					// the finally block below and return false.
					const meta = buildClaudeStoredMeta(message, model ?? "");
					if (meta) {
						emitter.contextUsageUpdated(
							requestId,
							sessionId,
							JSON.stringify(meta),
						);
					}
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
				logger.error("Claude session cleanup failed during q.close()", {
					requestId,
					sessionId,
					...errorDetails(closeErr),
				});
			}
			promptSource.close();
			this.sessions.delete(sessionId);
			// Only cancel waiters belonging to THIS session — `pendingUserInputs`
			// is manager-wide and other sessions may have parked AUQs / MCP
			// elicitations on it.
			for (const [userInputId, entry] of this.pendingUserInputs) {
				if (entry.sessionId !== sessionId) continue;
				this.pendingUserInputs.delete(userInputId);
				entry.resolve({ action: "cancel" });
			}
		}
	}

	/**
	 * Real mid-turn steer: push a `SDKUserMessage` into the active turn's
	 * streaming-input queue so the SDK folds it into the current extended
	 * turn, and emit a `user_prompt` passthrough event so the accumulator
	 * renders the user bubble at the correct position AND streaming.rs
	 * persists it exactly once (no extra DB path).
	 *
	 * Event shape matches `persist_user_message`'s DB row exactly:
	 * `{ type: "user_prompt", text: <raw prompt>, steer: true, files }`.
	 * We emit the RAW prompt (not the image-stripped version), keeping
	 * every `@/image.png` / `@src/foo.ts` / custom-tag sigil intact —
	 * that's what the adapter's `split_user_text_with_files` relies on
	 * to produce FileMention badges, and matches what a non-steer
	 * initial prompt stores. The image stripping is ONLY used to build
	 * the `SDKUserMessage` base64 image blocks we hand to the SDK.
	 *
	 * Two correctness properties this method enforces:
	 *
	 *   1. **Ghost-steer rejection.** The SDK emits ONE terminal `result`
	 *      for the whole streaming session; once the for-await loop sees
	 *      it, the finally block closes `promptSource`. If our image-
	 *      loading await straddles that boundary, a naive post-await
	 *      emit would plant a synthetic event into the pipeline with no
	 *      assistant response behind it. Re-check `promptSource.closed`
	 *      after the await to refuse the steer in that window.
	 *
	 *   2. **Strict ordering with post-steer deltas.** Emit the synthetic
	 *      event BEFORE `promptSource.push()`. Both are synchronous so
	 *      no other JS code can interleave, and the accumulator observes
	 *      `user_prompt` strictly before any deltas the SDK generates
	 *      in response.
	 *
	 * Returns `true` on success, `false` when no active session or when
	 * the turn finished while we were preparing the message.
	 */
	async steer(
		sessionId: string,
		prompt: string,
		files: readonly string[],
		images: readonly string[],
	): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session || session.promptSource.closed) {
			return false;
		}

		// Strip image refs to build the SDK's base64 image content. Keep
		// the raw prompt separately — that's what the synthetic event +
		// DB row need so `@-refs` survive the round-trip.
		const { text: stripped, imagePaths } = parseImageRefs(prompt, images);
		const sdkMessage =
			imagePaths.length === 0
				? ({
						type: "user",
						message: { role: "user", content: prompt },
						parent_tool_use_id: null,
					} as SDKUserMessage)
				: await buildUserMessageWithImages(stripped, imagePaths);

		// Re-check after the image-loading await — during those awaits
		// the for-await loop may have hit the extended turn's single
		// terminal result and closed our queue. Without this guard a
		// late image-steer call would plant a ghost bubble.
		if (session.promptSource.closed) {
			return false;
		}

		// Both `files` AND `images` must travel on the synthetic event so
		// the persisted DB row matches what `createLiveThreadMessage`
		// optimistically rendered. Without `images`, image badges in the
		// steer bubble would vanish on reload because the adapter has no
		// needle pool to find the `@<path>` substring with.
		const event: {
			type: "user_prompt";
			text: string;
			steer: true;
			files?: string[];
			images?: string[];
		} = { type: "user_prompt", text: prompt, steer: true };
		if (files.length > 0) event.files = [...files];
		if (imagePaths.length > 0) event.images = [...imagePaths];
		session.emitter.passthrough(session.requestId, event);
		session.promptSource.push(sdkMessage);
		logger.info(`steer ${sessionId}`, {
			preview: prompt.slice(0, 60),
			fileCount: files.length,
			imageCount: imagePaths.length,
		});
		return true;
	}

	async generateTitle(
		requestId: string,
		userMessage: string,
		branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		timeoutMs = TITLE_GENERATION_TIMEOUT_MS,
		options?: GenerateTitleOptions,
	): Promise<void> {
		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), timeoutMs);
		const model = options?.model?.trim() || "haiku";
		const claudeEnv =
			options?.claudeEnvironment &&
			Object.keys(options.claudeEnvironment).length > 0
				? options.claudeEnvironment
				: undefined;

		const generateBranch = options?.generateBranch ?? true;
		const q = query({
			prompt: buildTitlePrompt(userMessage, branchRenamePrompt, generateBranch),
			options: {
				abortController,
				pathToClaudeCodeExecutable: CLAUDE_BIN_PATH,
				...(claudeEnv ? { env: claudeEnv } : {}),
				model,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				thinking: { type: "disabled" },
				settingSources: [],
				tools: [],
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
			logger.info(`[${requestId}] titleGenerated`, {
				title,
				branchName: branchName ?? "(empty)",
				rawPreview: raw.slice(0, 200),
			});
			emitter.titleGenerated(requestId, title, branchName);
		} finally {
			clearTimeout(timeout);
			try {
				q.close();
			} catch (closeErr) {
				logger.error(
					"Claude title generation cleanup failed during q.close()",
					{
						requestId,
						...errorDetails(closeErr),
					},
				);
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
		// Retry once on "Query closed before response received" — it's a
		// transient race (claude-code child preempted or torn down between
		// init and the control-protocol reply), not a real failure.
		try {
			return await this.listSlashCommandsOnce(params);
		} catch (err) {
			if (isQueryClosedTransient(err)) {
				return this.listSlashCommandsOnce(params);
			}
			throw err;
		}
	}

	private async listSlashCommandsOnce(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		const { cwd } = params;
		const abortController = new AbortController();
		const additionalDirectories = [...(params.additionalDirectories ?? [])];
		const additionalDirectoryEnv =
			additionalDirectories.length > 0
				? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" }
				: undefined;
		const queryEnv = mergeQueryEnv(additionalDirectoryEnv);

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
				pathToClaudeCodeExecutable: CLAUDE_BIN_PATH,
				cwd: cwd || undefined,
				...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
				...(queryEnv ? { env: queryEnv } : {}),
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
			} catch (err) {
				if (!isAbortError(err)) {
					logger.error("Claude slash-command drain failed", {
						cwd: cwd || "(none)",
						...errorDetails(err),
					});
				}
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
			} catch (err) {
				logger.error("Claude slash-command timeout abort failed", {
					cwd: cwd || "(none)",
					...errorDetails(err),
				});
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
			} catch (err) {
				logger.error("Claude slash-command cleanup failed during abort()", {
					cwd: cwd || "(none)",
					...errorDetails(err),
				});
			}
			try {
				q.close();
			} catch (err) {
				logger.error("Claude slash-command cleanup failed during q.close()", {
					cwd: cwd || "(none)",
					...errorDetails(err),
				});
			}
			await drain.catch((err) => {
				if (!isAbortError(err)) {
					logger.error("Claude slash-command drain join failed", {
						cwd: cwd || "(none)",
						...errorDetails(err),
					});
				}
			});
		}
	}

	async listModels(_opts?: {
		apiKey?: string;
	}): Promise<readonly ProviderModelInfo[]> {
		return listProviderModels("claude");
	}

	/**
	 * Rich context-usage breakdown for the hover popover. Two paths:
	 *
	 *   - **Fast**: a live `Query` is already open for this helmor session
	 *     (user just sent a turn, the stream is still running). Reuse it;
	 *     the SDK answers the control call in <100ms.
	 *   - **Slow**: between turns — spawn a transient `Query` with
	 *     `resume: providerSessionId` + the caller-supplied `model`/`cwd`
	 *     so the SDK loads the same window size the user sees, ask it
	 *     `getContextUsage()`, then tear down. Same pattern as
	 *     `listModels` — the prompt iterator parks forever so the
	 *     underlying CLI never starts a turn.
	 *
	 * Returns the slim JSON string ready to ship back over IPC.
	 */
	async getContextUsage(params: GetContextUsageParams): Promise<string> {
		const { helmorSessionId, providerSessionId, model, cwd } = params;

		const live = this.sessions.get(helmorSessionId);
		if (live) {
			const raw = await live.query.getContextUsage();
			return JSON.stringify(buildClaudeRichMeta(raw, model));
		}

		// Slow path: spawn a transient Query. `resume` is optional — when
		// the helmor session hasn't run a turn yet there's no provider
		// session id to resume, but `q.getContextUsage()` still reports
		// the baseline (system prompt + tools + memory + skills) for the
		// selected model, which is exactly what the hover popover should
		// show on a fresh session.
		const abortController = new AbortController();
		let resolveDone: () => void = () => undefined;
		const donePromise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const promptIter: AsyncIterable<SDKUserMessage> =
			(async function* (): AsyncGenerator<never> {
				await donePromise;
				yield* [];
			})();

		const q = query({
			prompt: promptIter,
			options: {
				abortController,
				pathToClaudeCodeExecutable: CLAUDE_BIN_PATH,
				cwd: cwd || undefined,
				model: model || undefined,
				...(providerSessionId ? { resume: providerSessionId } : {}),
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				includePartialMessages: false,
				settingSources: ["user", "project", "local"],
			},
		});

		const drain = (async () => {
			try {
				for await (const _ of q) {
					void _;
				}
			} catch (err) {
				if (!isAbortError(err)) {
					logger.error(
						"Claude getContextUsage drain failed",
						errorDetails(err),
					);
				}
			}
		})();

		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			abortController.abort();
		}, CONTEXT_USAGE_TIMEOUT_MS);

		try {
			const raw = await q.getContextUsage();
			return JSON.stringify(buildClaudeRichMeta(raw, model));
		} catch (err) {
			if (timedOut) {
				throw new Error(
					`getContextUsage timed out after ${CONTEXT_USAGE_TIMEOUT_MS}ms`,
				);
			}
			throw err;
		} finally {
			clearTimeout(timeout);
			resolveDone();
			try {
				abortController.abort();
			} catch {
				/* noop */
			}
			try {
				q.close();
			} catch {
				/* noop */
			}
			await drain.catch(() => {});
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
		const snapshot = Array.from(this.sessions.entries());
		for (const [sessionId, session] of snapshot) {
			try {
				session.query.close();
			} catch (err) {
				logger.error("Claude shutdown failed during query.close()", {
					sessionId,
					...errorDetails(err),
				});
			}
		}
		this.sessions.clear();
		for (const [userInputId, entry] of this.pendingUserInputs) {
			this.pendingUserInputs.delete(userInputId);
			entry.resolve({ action: "cancel" });
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

/** Terminal result — success OR error. Both shapes carry
 *  `usage`/`modelUsage`, so both should update the ring. AskUserQuestion
 *  pauses live inside `canUseTool` instead of producing a result event,
 *  so any `result` we see here is genuinely terminal for this turn. */
function isTerminalResult(message: SDKMessage): boolean {
	return message.type === "result";
}

function stripUserInputToolUseFromAssistant(
	message: SDKMessage,
): object | null {
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
		if (!isUserInputToolUseBlock(block)) {
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

function isUserInputToolUseBlock(block: unknown): boolean {
	if (typeof block !== "object" || block === null) {
		return false;
	}

	const value = block as { type?: unknown; name?: unknown };
	return (
		value.type === "tool_use" &&
		typeof value.name === "string" &&
		USER_INPUT_TOOL_NAMES.has(value.name)
	);
}

/**
 * Extract plan text from ExitPlanMode input.
 * Supports both inline `plan` (v1) and file-based `filePath` (v2).
 */
function extractExitPlanContent(
	input: Record<string, unknown> | undefined,
): string | null {
	if (!input) return null;
	if (typeof input.plan === "string" && input.plan.trim()) {
		return input.plan;
	}
	if (typeof input.filePath === "string" && input.filePath.trim()) {
		try {
			const content = readFileSync(input.filePath, "utf-8").trim();
			return content || null;
		} catch {
			return null;
		}
	}
	return null;
}
