import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-turn async context so the worker's process-level fatal handler can
 * attribute a detached SDK fault (a raw `[unauthenticated]` / network error
 * thrown from the HTTP/2 client's background task, escaping every try/catch)
 * to the session that spawned it — instead of failing every session.
 *
 * Set in `CursorCore.sendMessage` (wrapping `Agent.create` / `agent.send` /
 * the stream loop, where the SDK's background tasks are born, so they inherit
 * the context); read in `worker.ts`'s `handleFatal`.
 */
export const sessionContext = new AsyncLocalStorage<{ sessionId: string }>();

export type FatalScope =
	| { kind: "session"; sessionId: string }
	| { kind: "all" };

/**
 * Decide which in-flight turns a worker-fatal should terminate.
 *
 * Auth faults are per-stream — a `[unauthenticated]` / 401 status is returned
 * on one session's specific stream and doesn't kill siblings — so we trust the
 * async-context attribution (`attributedSessionId`) and scope the failure to
 * just that session (the #868 cascade fix).
 *
 * Network/connection faults may instead be connection-level: if the SDK pools
 * one HTTP/2 connection across sessions, a GOAWAY/RST kills every stream but
 * surfaces in only one session's async context. Attributing those would leave
 * the real victims hung (no terminal event ever fires), so for non-auth faults
 * we fall back to the blunt-but-safe "fail every in-flight turn" — except when
 * a lone turn is live, which is unambiguous regardless of cause.
 */
export function fatalScope(
	isAuth: boolean,
	attributedSessionId: string | undefined,
	activeSessionIds: readonly string[],
): FatalScope {
	if (isAuth && attributedSessionId) {
		return { kind: "session", sessionId: attributedSessionId };
	}
	const [only] = activeSessionIds;
	if (activeSessionIds.length === 1 && only !== undefined) {
		return { kind: "session", sessionId: only };
	}
	return { kind: "all" };
}
