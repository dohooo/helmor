/**
 * Helmor Sidecar — Agent SDK bridge.
 *
 * Wraps both Claude Agent SDK and Codex SDK behind a unified
 * stdin/stdout JSON Lines protocol. Requests flow in via stdin,
 * responses and streaming events flow out via stdout. stderr is
 * used for debug logging only.
 *
 * Set HELMOR_SIDECAR_DEBUG=1 for verbose logging.
 */

import { createInterface } from "node:readline";
import { CodexSessionManager } from "./codex-session-manager.js";
import { SessionManager } from "./session-manager.js";

const DEBUG = process.env.HELMOR_SIDECAR_DEBUG === "1" || process.env.HELMOR_SIDECAR_DEBUG === "true";

function debug(...args: unknown[]) {
	if (DEBUG) {
		console.error("[sidecar:ts:debug]", ...args);
	}
}

const claudeSessions = new SessionManager();
const codexSessions = new CodexSessionManager();

debug("Sidecar process starting, pid =", process.pid);

// Signal readiness
const ready = { type: "ready", version: 1 };
process.stdout.write(`${JSON.stringify(ready)}\n`);
debug("Ready signal sent");

const rl = createInterface({ input: process.stdin });
let requestCount = 0;

for await (const line of rl) {
	if (!line.trim()) continue;

	let request: {
		id: string;
		method: string;
		params: Record<string, unknown>;
	};

	try {
		request = JSON.parse(line);
	} catch {
		emit({ type: "error", message: `Invalid JSON: ${line.slice(0, 100)}` });
		continue;
	}

	const { id, method, params } = request;
	requestCount++;

	debug(`← stdin [${id}] method=${method} provider=${params.provider ?? "claude"} (#${requestCount})`);
	if (DEBUG && method === "sendMessage") {
		debug(`  prompt="${String(params.prompt ?? "").slice(0, 80)}..." model=${params.model} cwd=${params.cwd} resume=${params.resume ?? "none"}`);
	}

	try {
		switch (method) {
			case "sendMessage": {
				// Route to the correct provider's session manager
				const provider = (params.provider as string) ?? "claude";
				const manager = provider === "codex" ? codexSessions : claudeSessions;

				let eventCount = 0;
				const debugEmit: typeof emit = (data) => {
					eventCount++;
					if (DEBUG && eventCount <= 3) {
						debug(`  → emit [${id}] type=${data.type} (#${eventCount})`);
					}
					emit(data);
				};

				// Don't await — runs concurrently, streams events via emit()
				manager
					.sendMessage(
						id,
						params as {
							sessionId: string;
							prompt: string;
							model?: string;
							cwd?: string;
							resume?: string;
							permissionMode?: string;
						},
						debugEmit,
					)
					.then(() => {
						debug(`[${id}] sendMessage completed — ${eventCount} events emitted`);
					})
					.catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						debug(`[${id}] sendMessage FAILED: ${msg}`);
						emit({
							id,
							type: "error",
							message: msg,
						});
					});
				break;
			}

			case "stopSession": {
				const stopProvider = (params.provider as string) ?? "claude";
				const stopManager =
					stopProvider === "codex" ? codexSessions : claudeSessions;
				debug(`[${id}] Stopping session ${params.sessionId}`);
				await stopManager.stopSession(params.sessionId as string);
				emit({ id, type: "stopped", sessionId: params.sessionId });
				break;
			}

			case "ping":
				emit({ id, type: "pong" });
				break;

			default:
				debug(`[${id}] Unknown method: ${method}`);
				emit({ id, type: "error", message: `Unknown method: ${method}` });
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		debug(`[${id}] Top-level error: ${msg}`);
		emit({
			id,
			type: "error",
			message: msg,
		});
	}
}

debug("stdin closed — sidecar exiting");

function emit(data: Record<string, unknown>) {
	process.stdout.write(`${JSON.stringify(data)}\n`);
}
