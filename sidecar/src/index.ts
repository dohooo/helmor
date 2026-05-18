/**
 * Helmor Sidecar — Agent SDK bridge.
 *
 * Bridges the Claude Agent SDK and Codex SDK behind a unified
 * stdin/stdout JSON Lines protocol. Requests come in via stdin, responses
 * and streaming events go out via stdout. stderr is for debug logging.
 *
 * Log level controlled by HELMOR_LOG (debug|info|error), defaults to info.
 */

import { createInterface } from "node:readline";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { isAbortError } from "./abort.js";
import { ClaudeSessionManager } from "./claude-session-manager.js";
import { CodexAppServerManager } from "./codex-app-server-manager.js";
import { CursorSessionManager } from "./cursor-session-manager.js";
import { createSidecarEmitter } from "./emitter.js";
import { errorDetails, logger } from "./logger.js";
import {
	errorMessage,
	optionalObject,
	optionalString,
	parseGetContextUsageParams,
	parseListSlashCommandsParams,
	parseOptionalStringRecord,
	parseProvider,
	parseRequest,
	parseSendMessageParams,
	parseSteerSessionParams,
	type RawRequest,
	requireString,
} from "./request-parser.js";
import type {
	Provider,
	SessionManager,
	UserInputResolution,
} from "./session-manager.js";
import {
	TITLE_GENERATION_FALLBACK_TIMEOUT_MS,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

const claudeManager = new ClaudeSessionManager();
const codexManager = new CodexAppServerManager();
const cursorManager = new CursorSessionManager();
const managers: Record<Provider, SessionManager> = {
	claude: claudeManager,
	codex: codexManager,
	cursor: cursorManager,
};

// `parentGone` flips to true only when stdin EOFs — that's the
// authoritative "Rust exited" signal. EPIPE on stdout, by contrast, can
// fire transiently from any pipe in the process (Anthropic SDK child
// processes, internal Bun async paths, etc.); using EPIPE alone as the
// exit trigger silently kills every in-flight query whenever any of
// those pipes blip (issues #398/#402). Set the flag here so the EPIPE
// handlers below can distinguish the two.
let parentGone = false;

function handleStdioError(stream: "stdout" | "stderr") {
	return (err: NodeJS.ErrnoException) => {
		if (err.code === "EPIPE") {
			if (parentGone) {
				process.exit(0);
			}
			// Transient EPIPE while parent is still alive — drop this
			// write. Don't escalate.
			return;
		}
		// Report through the OTHER stream to avoid recursion.
		if (stream === "stdout") {
			try {
				process.stderr.write(`[helmor-sidecar] stdout error: ${err.message}\n`);
			} catch {}
		}
	};
}
process.stdout.on("error", handleStdioError("stdout"));
process.stderr.on("error", handleStdioError("stderr"));

const emitter = createSidecarEmitter((event) => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
});

// ---------------------------------------------------------------------------
// Heartbeat — emit a lightweight keepalive every 15s for every in-flight
// stream request. Rust's streaming loop uses its absence (no event for
// >45s) to distinguish "sidecar frozen" from "AI legitimately running a
// long tool call". Heartbeats carry no payload beyond the request id.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 15_000;
const activeStreamIds = new Set<string>();
let heartbeatTickCount = 0;

setInterval(() => {
	heartbeatTickCount++;
	if (activeStreamIds.size === 0) return;
	// Log every tick at debug so the logs show heartbeats are flowing.
	logger.debug(
		`heartbeat tick #${heartbeatTickCount} for ${activeStreamIds.size} active stream(s)`,
		{ ids: [...activeStreamIds] },
	);
	for (const id of activeStreamIds) {
		try {
			emitter.heartbeat(id);
		} catch {
			// stdout closed — nothing to do
		}
	}
}, HEARTBEAT_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Global error recovery — the sidecar must never crash from unhandled errors.
// Log to stderr so Rust can capture it, emit a protocol error event so any
// in-flight request gets notified, and keep the process alive.
// ---------------------------------------------------------------------------

// Log-only handlers. Real sidecar crash is detected by Rust on EOF;
// broadcasting a null-id error here would tear down every in-flight
// stream over a transient Cursor NGHTTP2/TLS hiccup (#398/#402).
process.on("uncaughtException", (err) => {
	logger.error("uncaughtException", errorDetails(err));
});

process.on("unhandledRejection", (reason) => {
	// Cursor SDK opens background HTTP/2 sessions (statsig, run-event
	// tailer) that periodically trip transport-level errors. The
	// user-facing turn is awaited inside the manager's try/catch, so
	// these are by construction off-path — demote to info.
	if (isCursorSdkBackgroundChannelError(reason)) {
		logger.info(
			"Suppressed Cursor SDK background-channel transient error",
			errorDetails(reason),
		);
		return;
	}
	logger.error("unhandledRejection", errorDetails(reason));
});

const TRANSIENT_NODE_ERROR_CODES = new Set([
	// TLS SAN mismatch (Cursor side channels).
	"ERR_TLS_CERT_ALTNAME_INVALID",
	// HTTP/2 stream-level resets (FRAME_SIZE_ERROR, REFUSED_STREAM, ...).
	"ERR_HTTP2_STREAM_ERROR",
	"ERR_HTTP2_INVALID_STREAM",
	"ERR_HTTP2_GOAWAY_SESSION",
	// Socket-level.
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
]);

function isCursorSdkBackgroundChannelError(reason: unknown): boolean {
	if (!(reason instanceof Error)) return false;
	if (reason.name !== "ConnectError") return false;
	for (const code of collectErrorChainCodes(reason)) {
		if (TRANSIENT_NODE_ERROR_CODES.has(code)) return true;
	}
	// Fallback: HTTP/2 errors sometimes lose `.code`; match by message.
	const msg = reason.message;
	return /NGHTTP2_/.test(msg) || /Stream closed with error code/i.test(msg);
}

function collectErrorChainCodes(err: Error): string[] {
	const codes: string[] = [];
	const seen = new Set<unknown>();
	let curr: unknown = err;
	while (curr && !seen.has(curr)) {
		seen.add(curr);
		const c = (curr as { code?: unknown }).code;
		if (typeof c === "string") codes.push(c);
		curr = (curr as { cause?: unknown }).cause;
	}
	return codes;
}

logger.info("Sidecar starting", { pid: process.pid });
emitter.ready(1);

// ---------------------------------------------------------------------------
// Per-method handlers. Each one is responsible for catching its own errors
// and reporting them via `emitter.error`. None of them throws.
// ---------------------------------------------------------------------------

async function handleSendMessage(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	activeStreamIds.add(id);
	logger.debug(
		`[${id}] stream tracking: +1 (now ${activeStreamIds.size} active)`,
	);
	try {
		const provider = parseProvider(params.provider);
		const sendParams = parseSendMessageParams(params);
		logger.debug(`[${id}] sendMessage`, {
			prompt: sendParams.prompt?.slice(0, 100),
			model: sendParams.model ?? "(default)",
			cwd: sendParams.cwd ?? "(none)",
			resume: sendParams.resume ?? "(none)",
		});
		await managers[provider].sendMessage(id, sendParams, emitter);
		logger.debug(`[${id}] sendMessage completed`);
	} catch (err) {
		if (isAbortError(err)) {
			logger.debug(`[${id}] sendMessage aborted by user`);
			return;
		}
		const msg = errorMessage(err);
		logger.error(`[${id}] sendMessage FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	} finally {
		activeStreamIds.delete(id);
		logger.debug(
			`[${id}] stream tracking: -1 (now ${activeStreamIds.size} active)`,
		);
	}
}

async function handleGenerateTitle(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const userMessage = requireString(params, "userMessage");
		const branchRenamePrompt =
			typeof params.branchRenamePrompt === "string"
				? params.branchRenamePrompt
				: null;
		const claudeModel = optionalString(params, "claudeModel");
		const claudeEnvironment = parseOptionalStringRecord(
			params,
			"claudeEnvironment",
		);
		// Default true so older clients without the field keep getting both
		// title and branch. Pass `false` to skip the branch slug entirely.
		const generateBranch =
			typeof params.generateBranch === "boolean" ? params.generateBranch : true;
		logger.debug(`[${id}] generateTitle`, {
			userMessage: userMessage.slice(0, 100),
			claudeModel: claudeModel ?? "haiku",
			customClaudeEnvironment: Boolean(claudeEnvironment),
			generateBranch,
		});

		// Try the configured Claude-compatible model first when available;
		// otherwise use official Claude, then fall back to Codex, then
		// fall back to Cursor. The chain order is by ascending cost-of-
		// last-resort: Claude/Codex pay nothing per-call (their CLI
		// auth covers it), Cursor inference is metered against the
		// user's plan, so it stays at the end.
		try {
			await managers.claude.generateTitle(
				id,
				userMessage,
				branchRenamePrompt,
				emitter,
				TITLE_GENERATION_TIMEOUT_MS,
				{ model: claudeModel, claudeEnvironment, generateBranch },
			);
			logger.debug(`[${id}] generateTitle completed (claude)`);
		} catch (claudeErr) {
			if (claudeModel || claudeEnvironment) {
				logger.debug(
					`[${id}] generateTitle custom claude failed, trying official claude: ${errorMessage(claudeErr)}`,
				);
				try {
					await managers.claude.generateTitle(
						id,
						userMessage,
						branchRenamePrompt,
						emitter,
						TITLE_GENERATION_TIMEOUT_MS,
						{ generateBranch },
					);
					logger.debug(`[${id}] generateTitle completed (official claude)`);
					return;
				} catch (officialClaudeErr) {
					logger.debug(
						`[${id}] generateTitle official claude failed, trying codex: ${errorMessage(officialClaudeErr)}`,
					);
				}
			} else {
				logger.debug(
					`[${id}] generateTitle claude failed, trying codex: ${errorMessage(claudeErr)}`,
				);
			}
			try {
				await managers.codex.generateTitle(
					id,
					userMessage,
					branchRenamePrompt,
					emitter,
					TITLE_GENERATION_FALLBACK_TIMEOUT_MS,
					{ generateBranch },
				);
				logger.debug(`[${id}] generateTitle completed (codex fallback)`);
			} catch (codexErr) {
				logger.debug(
					`[${id}] generateTitle codex failed, trying cursor: ${errorMessage(codexErr)}`,
				);
				await managers.cursor.generateTitle(
					id,
					userMessage,
					branchRenamePrompt,
					emitter,
					TITLE_GENERATION_FALLBACK_TIMEOUT_MS,
					{ generateBranch },
				);
				logger.debug(`[${id}] generateTitle completed (cursor fallback)`);
			}
		}
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] generateTitle FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	}
}

async function handleListModels(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const provider = parseProvider(params.provider);
		// Optional override key — onboarding uses this to validate a key
		// before persisting it to settings.
		const apiKey =
			typeof params.apiKey === "string" && params.apiKey.length > 0
				? params.apiKey
				: undefined;
		logger.debug(`[${id}] listModels`, { provider, override: Boolean(apiKey) });
		const models = await managers[provider].listModels(
			apiKey ? { apiKey } : undefined,
		);
		emitter.modelsListed(id, provider, models);
		logger.debug(`[${id}] listModels → ${models.length} entries (${provider})`);
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] listModels FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	}
}

async function handleListSlashCommands(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const provider = parseProvider(params.provider);
		const listParams = parseListSlashCommandsParams(params);
		logger.debug(`[${id}] listSlashCommands`, {
			provider,
			cwd: listParams.cwd ?? "(none)",
		});
		const commands = await managers[provider].listSlashCommands(listParams);
		emitter.slashCommandsListed(id, commands);
		logger.debug(`[${id}] listSlashCommands → ${commands.length} entries`);
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] listSlashCommands FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	}
}

async function handleStopSession(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const provider = parseProvider(params.provider);
		const sessionId = requireString(params, "sessionId");
		logger.debug(`[${id}] stopSession`, { sessionId, provider });
		await managers[provider].stopSession(sessionId);
		emitter.stopped(id, sessionId);
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] stopSession FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	}
}

async function handleGetContextUsage(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const getParams = parseGetContextUsageParams(params);
		logger.debug(`[${id}] getContextUsage`, {
			sessionId: getParams.helmorSessionId,
			providerSessionId: getParams.providerSessionId ?? "(none)",
			model: getParams.model ?? "(default)",
			cwd: getParams.cwd ?? "(none)",
		});
		const meta = await claudeManager.getContextUsage(getParams);
		emitter.contextUsageResult(id, meta);
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] getContextUsage FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	}
}

/// Hot-push runtime config (Cursor API key). Restarting the sidecar
/// would interrupt unrelated in-flight Claude/Codex turns.
function handleUpdateConfig(id: string, params: Record<string, unknown>): void {
	try {
		if ("cursorApiKey" in params) {
			const raw = params.cursorApiKey;
			const next = typeof raw === "string" ? raw : null;
			cursorManager.setApiKey(next);
		}
		emitter.pong(id);
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] updateConfig FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	}
}

async function handleMutateCodexGoal(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const sessionId = requireString(params, "sessionId");
		const actionRaw = requireString(params, "action");
		if (actionRaw !== "pause" && actionRaw !== "clear") {
			throw new Error(`Invalid mutateCodexGoal action: ${actionRaw}`);
		}
		logger.debug(`[${id}] mutateCodexGoal`, { sessionId, action: actionRaw });
		await codexManager.mutateGoal(sessionId, actionRaw);
		emitter.pong(id);
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] mutateCodexGoal FAILED: ${msg}`, errorDetails(err));
		emitter.error(id, msg);
	}
}

async function handleSteerSession(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const provider = parseProvider(params.provider);
		const { sessionId, prompt, files, images } =
			parseSteerSessionParams(params);
		logger.debug(`[${id}] steerSession`, {
			sessionId,
			provider,
			preview: prompt.slice(0, 80),
			fileCount: files.length,
			imageCount: images.length,
		});
		const accepted = await managers[provider].steer(
			sessionId,
			prompt,
			files,
			images,
		);
		emitter.steered(
			id,
			sessionId,
			accepted,
			accepted ? undefined : "no_active_turn",
		);
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] steerSession FAILED: ${msg}`, errorDetails(err));
		const sessionId =
			typeof params.sessionId === "string" ? params.sessionId : "";
		emitter.steered(id, sessionId, false, msg);
	}
}

/**
 * Cooperative shutdown — closes every live session across all providers and
 * exits the process. The Rust side calls this before escalating to SIGTERM /
 * SIGKILL so the Claude SDK gets a chance to send `Query.close()` (which
 * cleans up the claude-code child) and the Codex SDK gets a chance to abort
 * its `codex exec` children. Acks via `pong` so the parent can wait on a
 * known event before tearing down stdio.
 */
async function handleShutdown(id: string): Promise<void> {
	logger.info(`[${id}] shutdown — tearing down all sessions`);
	const results = await Promise.allSettled([
		...Object.values(managers).map((m) => m.shutdown()),
		...inflightHandlers,
	]);
	for (const r of results) {
		if (r.status === "rejected") {
			logger.error("shutdown: manager rejected", errorDetails(r.reason));
		}
	}
	emitter.pong(id);
	logger.info("shutdown ack sent — exiting in next tick");
	// Give the stdout pipe a tick to flush the pong before exit.
	setImmediate(() => process.exit(0));
}

// ---------------------------------------------------------------------------
// In-flight handler tracking — so shutdown can await pending work.
// ---------------------------------------------------------------------------

const inflightHandlers = new Set<Promise<void>>();

function trackHandler(p: Promise<void>): void {
	inflightHandlers.add(p);
	p.finally(() => inflightHandlers.delete(p));
}

// ---------------------------------------------------------------------------
// Main loop — dispatch only. Long-running methods are fire-and-forget so
// the loop can keep accepting new requests (e.g. a stopSession arriving
// while a sendMessage is mid-stream).
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });
// Authoritative "Rust exited" signal — flip the flag so any subsequent
// EPIPE on stdout/stderr is treated as "drain to /dev/null then exit"
// rather than "transient blip, ignore".
rl.on("close", () => {
	parentGone = true;
});
let requestCount = 0;

for await (const line of rl) {
	if (!line.trim()) continue;

	let request: RawRequest;
	try {
		request = parseRequest(line);
	} catch (err) {
		logger.error("Invalid request", {
			lineLength: line.length,
			...errorDetails(err),
		});
		emitter.error(
			null,
			`Invalid request: ${errorMessage(err)} (${line.slice(0, 100)})`,
		);
		continue;
	}

	const { id, method, params } = request;
	requestCount++;
	logger.debug(`← stdin [${id}] method=${method}`, {
		provider: params.provider ?? "(unset)",
		count: requestCount,
	});

	try {
		switch (method) {
			case "sendMessage":
				trackHandler(handleSendMessage(id, params));
				break;
			case "generateTitle":
				trackHandler(handleGenerateTitle(id, params));
				break;
			case "listSlashCommands":
				trackHandler(handleListSlashCommands(id, params));
				break;
			case "listModels":
				trackHandler(handleListModels(id, params));
				break;
			case "getContextUsage":
				trackHandler(handleGetContextUsage(id, params));
				break;
			case "stopSession":
				await handleStopSession(id, params);
				break;
			case "steerSession":
				await handleSteerSession(id, params);
				break;
			case "mutateCodexGoal":
				await handleMutateCodexGoal(id, params);
				break;
			case "updateConfig":
				handleUpdateConfig(id, params);
				break;
			case "shutdown":
				await handleShutdown(id);
				break;
			case "permissionResponse": {
				const permissionId = params.permissionId as string;
				const behavior = params.behavior as "allow" | "deny";
				const updatedPermissions = Array.isArray(params.updatedPermissions)
					? (params.updatedPermissions as PermissionUpdate[])
					: undefined;
				const message =
					typeof params.message === "string" ? params.message : undefined;
				logger.debug(`[${id}] permissionResponse`, { permissionId, behavior });
				// Route to the right provider — Codex permissions use "codex-" prefix
				if (permissionId.startsWith("codex-")) {
					codexManager.resolvePermission(permissionId, behavior);
				} else {
					claudeManager.resolvePermission(
						permissionId,
						behavior,
						updatedPermissions,
						message,
					);
				}
				break;
			}
			case "userInputResponse": {
				// Unified resolver — covers Claude AskUserQuestion (canUseTool),
				// Claude MCP elicitation (onElicitation), and Codex
				// `requestUserInput`. Each provider's manager silently no-ops
				// when the userInputId isn't in its pending map, so we just
				// fan the call out to every provider.
				const userInputId = requireString(params, "userInputId");
				const action = requireString(params, "action") as
					| "submit"
					| "decline"
					| "cancel";
				const content = optionalObject(params, "content");
				logger.debug(`[${id}] userInputResponse`, { userInputId, action });
				const resolution: UserInputResolution =
					action === "submit"
						? { action, content: content ?? {} }
						: action === "decline"
							? { action, ...(content ? { content } : {}) }
							: { action: "cancel" };
				const claimed =
					claudeManager.resolveUserInput(userInputId, resolution) ||
					codexManager.resolveUserInput(userInputId, resolution);
				if (!claimed) {
					// No live waiter — the parked promise was lost (sidecar
					// restart, session ended, or duplicate submit). Surface
					// it instead of silently swallowing so the UI can
					// inform the user that the answer didn't reach the agent.
					logger.error(`[${id}] userInputResponse dropped`, {
						userInputId,
						action,
					});
					emitter.error(id, `No active waiter for userInputId=${userInputId}`);
				}
				break;
			}
			case "ping":
				emitter.pong(id);
				break;
			default:
				logger.error(`[${id}] Unknown method`, { method });
				emitter.error(id, `Unknown method: ${method}`);
		}
	} catch (err) {
		logger.error(`Dispatch error for [${id}] ${method}`, {
			method,
			...errorDetails(err),
		});
		emitter.error(id, "Internal sidecar error", true);
	}
}

logger.info("stdin closed — sidecar exiting");
