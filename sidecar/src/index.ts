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
import { ClaudeSessionManager } from "./claude-session-manager.js";
import { CodexSessionManager } from "./codex-session-manager.js";
import { createSidecarEmitter } from "./emitter.js";
import { logger } from "./logger.js";
import {
	errorMessage,
	parseListSlashCommandsParams,
	parseProvider,
	parseRequest,
	parseSendMessageParams,
	type RawRequest,
	requireString,
} from "./request-parser.js";
import type { Provider, SessionManager } from "./session-manager.js";

const claudeManager = new ClaudeSessionManager();
const managers: Record<Provider, SessionManager> = {
	claude: claudeManager,
	codex: new CodexSessionManager(),
};

const emitter = createSidecarEmitter((event) => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
});

// ---------------------------------------------------------------------------
// Global error recovery — the sidecar must never crash from unhandled errors.
// Log to stderr so Rust can capture it, emit a protocol error event so any
// in-flight request gets notified, and keep the process alive.
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
	logger.error("uncaughtException", { err: String(err) });
	try {
		emitter.error(null, "Internal sidecar error", true);
	} catch {
		// stdout may be broken — nothing more we can do
	}
});

process.on("unhandledRejection", (reason) => {
	logger.error("unhandledRejection", { reason: String(reason) });
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
		const msg = errorMessage(err);
		logger.error(`[${id}] sendMessage FAILED: ${msg}`);
		emitter.error(id, msg);
	}
}

async function handleGenerateTitle(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const userMessage = requireString(params, "userMessage");
		logger.debug(`[${id}] generateTitle`, {
			userMessage: userMessage.slice(0, 100),
		});

		// Try Claude (cheap haiku) first; fall back to Codex if Claude is
		// unavailable. Both implementations emit `titleGenerated` in the
		// same shape, so the caller can't tell which one ran.
		try {
			await managers.claude.generateTitle(id, userMessage, emitter);
			logger.debug(`[${id}] generateTitle completed (claude)`);
		} catch (claudeErr) {
			logger.debug(
				`[${id}] generateTitle claude failed, trying codex: ${errorMessage(claudeErr)}`,
			);
			await managers.codex.generateTitle(id, userMessage, emitter);
			logger.debug(`[${id}] generateTitle completed (codex fallback)`);
		}
	} catch (err) {
		const msg = errorMessage(err);
		logger.error(`[${id}] generateTitle FAILED: ${msg}`);
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
		logger.error(`[${id}] listSlashCommands FAILED: ${msg}`);
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
		emitter.error(id, errorMessage(err));
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
			logger.error(`shutdown: manager rejected: ${errorMessage(r.reason)}`);
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
			case "stopSession":
				await handleStopSession(id, params);
				break;
			case "shutdown":
				await handleShutdown(id);
				break;
			case "permissionResponse": {
				const permissionId = params.permissionId as string;
				const behavior = params.behavior as "allow" | "deny";
				logger.debug(`[${id}] permissionResponse`, { permissionId, behavior });
				claudeManager.resolvePermission(permissionId, behavior);
				break;
			}
			case "ping":
				emitter.pong(id);
				break;
			default:
				emitter.error(id, `Unknown method: ${method}`);
		}
	} catch (err) {
		logger.error(`Dispatch error for [${id}] ${method}`, { err: String(err) });
		emitter.error(id, "Internal sidecar error", true);
	}
}

logger.info("stdin closed — sidecar exiting");
