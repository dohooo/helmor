import type { SidecarEmitter } from "./emitter.js";

/**
 * Shared per-session active-turn tracking so every provider handles Stop
 * identically — no per-provider abort logic.
 *
 * The problem this solves: a manager that registers its session only AFTER
 * the (1-2s) first-turn startup (`ensureContext` / `Agent.create` /
 * `server.start`) can't honor a Stop pressed during startup, so the abort
 * lags until startup finishes.
 *
 * The fix (Claude's pattern, generalized): `sendMessage` calls `begin()`
 * BEFORE any await, capturing the turn's `emitter` + `requestId`.
 * `stopSession` then calls `requestStop()`, which emits the terminal
 * `aborted` INSTANTLY and runs the provider's `teardown` — at any point,
 * including mid-startup. The provider checks `isAbortRequested()` right
 * after startup to skip running the turn, and the streaming loop reads it
 * to avoid a duplicate terminal event.
 */
interface ActiveTurn {
	requestId: string;
	emitter: SidecarEmitter;
	abortEmitted: boolean;
	/** Provider-specific teardown (abort controller / kill server / cancel
	 *  run). May be upgraded via `setTeardown` once a fuller handle exists. */
	teardown: () => void;
}

export class ActiveTurnRegistry {
	private readonly turns = new Map<string, ActiveTurn>();

	/** Register a turn at `sendMessage` start, before any await. */
	begin(
		sessionId: string,
		requestId: string,
		emitter: SidecarEmitter,
		teardown: () => void,
	): void {
		this.turns.set(sessionId, {
			requestId,
			emitter,
			abortEmitted: false,
			teardown,
		});
	}

	/** Replace the teardown once a real handle exists (e.g. after the
	 *  server/agent/run is live). No-op if the turn already ended. */
	setTeardown(sessionId: string, teardown: () => void): void {
		const turn = this.turns.get(sessionId);
		if (turn) turn.teardown = teardown;
	}

	/** Stop the active turn: emit `aborted` now + run teardown. Idempotent;
	 *  no-op if there's no live turn (`begin` not yet called / already ended). */
	requestStop(sessionId: string): boolean {
		const turn = this.turns.get(sessionId);
		if (!turn || turn.abortEmitted) return false;
		turn.abortEmitted = true;
		turn.emitter.aborted(turn.requestId, "user_requested");
		try {
			turn.teardown();
		} catch {
			// best-effort — teardown must never throw past the stop
		}
		return true;
	}

	/** Whether Stop was requested for this turn. Providers gate the
	 *  post-startup turn dispatch + the streaming loop's terminal emit on it. */
	isAbortRequested(sessionId: string): boolean {
		return this.turns.get(sessionId)?.abortEmitted ?? false;
	}

	/** Clear the turn once a terminal event has been emitted. */
	end(sessionId: string): void {
		this.turns.delete(sessionId);
	}
}
