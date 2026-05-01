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
import { createSidecarEmitter } from "./emitter.js";
import { errorDetails, logger } from "./logger.js";
import {
	errorMessage,
	optionalString,
	parseElicitationResultContent,
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
import type { Provider, SessionManager } from "./session-manager.js";
import {
	TITLE_GENERATION_FALLBACK_TIMEOUT_MS,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

const claudeManager = new ClaudeSessionManager();
const codexManager = new CodexAppServerManager();
const managers: Record<Provider, SessionManager> = {
	claude: claudeManager,
	codex: codexManager,
};

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

process.on("uncaughtException", (err) => {
	logger.error("uncaughtException", errorDetails(err));
	try {
		emitter.error(null, "Internal sidecar error", true);
	} catch {
		// stdout may be broken — nothing more we can do
	}
});

process.on("unhandledRejection", (reason) => {
	logger.error("unhandledRejection", errorDetails(reason));
	try {
		emitter.error(null, "Internal sidecar error", true);
	} catch {
		// stdout may be broken
	}
});

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
		logger.debug(`[${id}] generateTitle`, {
			userMessage: userMessage.slice(0, 100),
			claudeModel: claudeModel ?? "haiku",
			customClaudeEnvironment: Boolean(claudeEnvironment),
		});

		// Try the configured Claude-compatible model first when available;
		// otherwise use official Claude, then fall back to Codex.
		try {
			await managers.claude.generateTitle(
				id,
				userMessage,
				branchRenamePrompt,
				emitter,
				TITLE_GENERATION_TIMEOUT_MS,
				{ model: claudeModel, claudeEnvironment },
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
			await managers.codex.generateTitle(
				id,
				userMessage,
				branchRenamePrompt,
				emitter,
				TITLE_GENERATION_FALLBACK_TIMEOUT_MS,
			);
			logger.debug(`[${id}] generateTitle completed (codex fallback)`);
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
		logger.debug(`[${id}] listModels`, { provider });
		const models = await managers[provider].listModels();
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

function optionalObject(
	params: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = params[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "object") {
		return value as Record<string, unknown>;
	}
	throw new Error(`params.${key} must be an object`);
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
			case "elicitationResponse": {
				const elicitationId = requireString(params, "elicitationId");
				const action = requireString(params, "action") as
					| "accept"
					| "decline"
					| "cancel";
				const content = parseElicitationResultContent(params, "content");
				logger.debug(`[${id}] elicitationResponse`, { elicitationId, action });
				claudeManager.resolveElicitation(elicitationId, {
					action,
					...(content ? { content } : {}),
				});
				break;
			}
			case "userInputResponse": {
				const userInputId = requireString(params, "userInputId");
				const answers = params.answers ?? null;
				logger.debug(`[${id}] userInputResponse`, { userInputId });
				codexManager.resolveUserInput(userInputId, answers);
				break;
			}
			case "deferredToolResponse": {
				const toolUseId = requireString(params, "toolUseId");
				const behavior = requireString(params, "behavior") as "allow" | "deny";
				const reason = optionalString(params, "reason");
				const updatedInput = optionalObject(params, "updatedInput");
				logger.debug(`[${id}] deferredToolResponse`, {
					toolUseId,
					behavior,
				});
				claudeManager.resolveDeferredTool(
					toolUseId,
					behavior,
					reason,
					updatedInput,
				);
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
