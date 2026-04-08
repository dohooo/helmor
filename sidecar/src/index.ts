/**
 * Helmor Sidecar — Agent SDK bridge.
 *
 * Bridges the Claude Agent SDK and Codex SDK behind a unified
 * stdin/stdout JSON Lines protocol. Requests come in via stdin, responses
 * and streaming events go out via stdout. stderr is for debug logging.
 *
 * Set HELMOR_SIDECAR_DEBUG=1 for verbose logging.
 */

import { createInterface } from "node:readline";
import { ClaudeSessionManager } from "./claude-session-manager.js";
import { CodexSessionManager } from "./codex-session-manager.js";
import { createSidecarEmitter } from "./emitter.js";
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

const DEBUG =
	process.env.HELMOR_SIDECAR_DEBUG === "1" ||
	process.env.HELMOR_SIDECAR_DEBUG === "true";

function debug(...args: unknown[]): void {
	if (DEBUG) {
		console.error("[sidecar:ts:debug]", ...args);
	}
}

const managers: Record<Provider, SessionManager> = {
	claude: new ClaudeSessionManager(),
	codex: new CodexSessionManager(),
};

const emitter = createSidecarEmitter((event) => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
});

debug("Sidecar starting, pid =", process.pid);
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
		if (DEBUG) {
			debug(
				`  prompt="${sendParams.prompt.slice(0, 80)}..." model=${sendParams.model ?? "(default)"} cwd=${sendParams.cwd ?? "(none)"} resume=${sendParams.resume ?? "(none)"}`,
			);
		}
		await managers[provider].sendMessage(id, sendParams, emitter);
		debug(`[${id}] sendMessage completed`);
	} catch (err) {
		const msg = errorMessage(err);
		debug(`[${id}] sendMessage FAILED: ${msg}`);
		emitter.error(id, msg);
	}
}

async function handleGenerateTitle(
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	try {
		const userMessage = requireString(params, "userMessage");
		debug(`[${id}] generateTitle — "${userMessage.slice(0, 60)}..."`);

		// Try Claude (cheap haiku) first; fall back to Codex if Claude is
		// unavailable. Both implementations emit `titleGenerated` in the
		// same shape, so the caller can't tell which one ran.
		try {
			await managers.claude.generateTitle(id, userMessage, emitter);
			debug(`[${id}] generateTitle completed (claude)`);
		} catch (claudeErr) {
			debug(
				`[${id}] generateTitle claude failed, trying codex: ${errorMessage(claudeErr)}`,
			);
			await managers.codex.generateTitle(id, userMessage, emitter);
			debug(`[${id}] generateTitle completed (codex fallback)`);
		}
	} catch (err) {
		const msg = errorMessage(err);
		debug(`[${id}] generateTitle FAILED: ${msg}`);
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
		debug(
			`[${id}] listSlashCommands provider=${provider} cwd=${listParams.cwd ?? "(none)"}`,
		);
		const commands = await managers[provider].listSlashCommands(listParams);
		emitter.slashCommandsListed(id, commands);
		debug(`[${id}] listSlashCommands → ${commands.length} entries`);
	} catch (err) {
		const msg = errorMessage(err);
		debug(`[${id}] listSlashCommands FAILED: ${msg}`);
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
		debug(`[${id}] stopSession sessionId=${sessionId} provider=${provider}`);
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
	debug(`[${id}] shutdown — tearing down all sessions`);
	const results = await Promise.allSettled(
		Object.values(managers).map((m) => m.shutdown()),
	);
	for (const r of results) {
		if (r.status === "rejected") {
			debug(`  shutdown: manager rejected: ${errorMessage(r.reason)}`);
		}
	}
	emitter.pong(id);
	debug("shutdown ack sent — exiting in next tick");
	// Give the stdout pipe a tick to flush the pong before exit.
	setImmediate(() => process.exit(0));
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
	debug(
		`← stdin [${id}] method=${method} provider=${params.provider ?? "(unset)"} (#${requestCount})`,
	);

	switch (method) {
		case "sendMessage":
			void handleSendMessage(id, params);
			break;
		case "generateTitle":
			void handleGenerateTitle(id, params);
			break;
		case "listSlashCommands":
			void handleListSlashCommands(id, params);
			break;
		case "stopSession":
			await handleStopSession(id, params);
			break;
		case "shutdown":
			await handleShutdown(id);
			break;
		case "ping":
			emitter.pong(id);
			break;
		default:
			emitter.error(id, `Unknown method: ${method}`);
	}
}

debug("stdin closed — sidecar exiting");
