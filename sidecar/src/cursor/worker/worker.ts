/** Node entry for the cursor worker. Runs `@cursor/sdk` on Node (whose
 * HTTP/2 client, unlike Bun's, handles the large frames Cursor sends inside a
 * git repo without `NGHTTP2_FRAME_SIZE_ERROR`). Speaks the JSON-Lines wire
 * protocol in `protocol.ts` with the Bun sidecar proxy over stdin/stdout.
 *
 * stdout is reserved for protocol lines only; everything else (SDK noise,
 * logger) goes to stderr, which the proxy drains into the sidecar log. */

import { createInterface } from "node:readline";
import { applyAgentProxyToProcessEnv } from "../../agent-proxy.js";
import type { SidecarEmitter } from "../../emitter.js";
import { CursorCore } from "./cursor-core.js";
import { isAuthError, isRetryableCursorError } from "./cursor-helpers.js";
import { sessionContext } from "./fatal-context.js";
import type { EmitMsg, FromWorker, ToWorker } from "./protocol.js";

// Keep stdout pristine: any stray console.log from the SDK would corrupt the
// protocol stream, so route it to stderr.
console.log = (...args: unknown[]) => console.error(...args);

function out(msg: FromWorker): void {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function emit(e: EmitMsg): void {
	out({ t: "emit", e });
}

/** A full `SidecarEmitter` whose calls cross the wire. The cursor SDK logic
 * (and the shared turn registry) only ever emit the methods serialized below;
 * the rest are off-path for cursor and no-op. */
const noop = (..._args: unknown[]): void => {};
const wireEmitter: SidecarEmitter = {
	error: (requestId, message, internal) =>
		emit({ m: "error", requestId, message, internal }),
	end: (requestId) => emit({ m: "end", requestId }),
	aborted: (requestId, reason) => emit({ m: "aborted", requestId, reason }),
	passthrough: (requestId, message) =>
		emit({ m: "passthrough", requestId, message }),
	planCaptured: (requestId, toolUseId, plan) =>
		emit({ m: "planCaptured", requestId, toolUseId, plan }),
	titleGenerated: (requestId, title, branchName) =>
		emit({ m: "titleGenerated", requestId, title, branchName }),
	ready: noop,
	stopped: noop,
	steered: noop,
	pong: noop,
	heartbeat: noop,
	slashCommandsListed: noop,
	permissionRequest: noop,
	userInputRequest: noop,
	userQuestionResolved: noop,
	permissionModeChanged: noop,
	modelsListed: noop,
	contextUsageUpdated: noop,
	contextUsageResult: noop,
	codexGoalUpdated: noop,
};

const core = new CursorCore();

// The worker is a permanent resident shared by every cursor session. Errors
// reach this handler only when they escape every try/catch — in practice that's
// the SDK's HTTP/2 client throwing an operational error from a detached
// background task (a network reset, or a raw `[unauthenticated]` ConnectError
// from an event stream). Operational errors don't corrupt the process, so we
// stay alive: log, fail the *originating* session's in-flight turn with an
// actionable message (`failTurnsForFatal`, attributed via `sessionContext`),
// and drop only that session — its next send re-resumes cleanly. Sibling
// sessions keep streaming. Killing the worker would cold-restart every other
// session for nothing.
//
// Error type selects ONLY the user-facing copy, never the process lifecycle.
//
// The sole reason to give up the process is a crash-loop: if fatals keep firing
// in a tight window the process is genuinely wedged (e.g. a leaked SDK
// background loop faulting on repeat that `agent.close()` didn't stop), so we
// exit once and let the supervisor respawn a clean worker.
const FATAL_LOOP_WINDOW_MS = 10_000;
const FATAL_LOOP_THRESHOLD = 5;
let fatalExiting = false;
let recentFatals: number[] = [];

function fatalReason(err: unknown, message: string): string {
	if (isRetryableCursorError(err))
		return "Cursor lost its network connection. Please send the message again.";
	if (isAuthError(err))
		return "Cursor authentication failed. Please send the message again; if it keeps failing, re-check your Cursor API key in Settings → Models → Cursor.";
	return `Cursor worker error: ${message}`;
}

function handleFatal(kind: string, err: unknown): void {
	const message = errMessage(err);
	console.error(`[cursor-worker] ${kind}: ${message}`);
	try {
		// Attribute the fault to its originating session (set in
		// CursorCore.sendMessage). Auth faults are per-session so they scope to
		// just it; non-auth faults may be connection-level and fall back to
		// failing every turn — see `failTurnsForFatal` / `fatalScope`.
		const attributedSessionId = sessionContext.getStore()?.sessionId;
		for (const requestId of core.failTurnsForFatal(
			fatalReason(err, message),
			isAuthError(err),
			attributedSessionId,
		)) {
			out({ t: "sendDone", requestId });
		}
	} catch (recoverErr) {
		console.error(`[cursor-worker] recovery failed: ${errMessage(recoverErr)}`);
	}

	// Crash-loop breaker — the only condition under which the permanent worker
	// gives up and lets the supervisor respawn.
	const now = Date.now();
	recentFatals = recentFatals.filter((t) => now - t < FATAL_LOOP_WINDOW_MS);
	recentFatals.push(now);
	if (recentFatals.length < FATAL_LOOP_THRESHOLD || fatalExiting) return;
	fatalExiting = true;
	console.error(
		`[cursor-worker] ${recentFatals.length} fatal errors within ${FATAL_LOOP_WINDOW_MS}ms — respawning a clean worker`,
	);
	// Let the terminal events flush to the parent, then exit.
	setTimeout(() => process.exit(1), 30);
}

process.on("uncaughtException", (err) => handleFatal("uncaughtException", err));
process.on("unhandledRejection", (reason) =>
	handleFatal("unhandledRejection", reason),
);

async function handle(msg: ToWorker): Promise<void> {
	switch (msg.t) {
		case "setApiKey":
			core.setApiKey(msg.apiKey);
			return;
		case "send":
			applyAgentProxyToProcessEnv(msg.params.agentProxy);
			// CursorCore emits its own terminal end/error; `sendDone` just
			// releases the proxy's awaiting promise.
			await core.sendMessage(msg.requestId, msg.params, wireEmitter);
			out({ t: "sendDone", requestId: msg.requestId });
			return;
		case "title":
			try {
				await core.generateTitle(
					msg.requestId,
					msg.userMessage,
					msg.branchRenamePrompt,
					wireEmitter,
					msg.timeoutMs,
					msg.options,
				);
				out({ t: "rpcOk", rpcId: msg.rpcId, value: [] });
			} catch (err) {
				out({ t: "rpcErr", rpcId: msg.rpcId, message: errMessage(err) });
			}
			return;
		case "slash":
			try {
				const value = await core.listSlashCommands(msg.params);
				out({ t: "rpcOk", rpcId: msg.rpcId, value: [...value] });
			} catch (err) {
				out({ t: "rpcErr", rpcId: msg.rpcId, message: errMessage(err) });
			}
			return;
		case "models":
			try {
				const value = await core.listModels(msg.opts);
				out({ t: "rpcOk", rpcId: msg.rpcId, value: [...value] });
			} catch (err) {
				out({ t: "rpcErr", rpcId: msg.rpcId, message: errMessage(err) });
			}
			return;
		case "stop":
			await core.stopSession(msg.sessionId);
			return;
		case "shutdown":
			await core.shutdown();
			process.exit(0);
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg: ToWorker;
	try {
		msg = JSON.parse(trimmed) as ToWorker;
	} catch {
		console.error(`[cursor-worker] bad request line: ${trimmed.slice(0, 200)}`);
		return;
	}
	void handle(msg).catch((err) => {
		console.error(`[cursor-worker] handler failed: ${errMessage(err)}`);
	});
});

// stdin EOF means the parent sidecar is gone — exit so we don't linger.
rl.on("close", () => process.exit(0));

out({ t: "ready" });
