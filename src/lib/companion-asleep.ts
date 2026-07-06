/**
 * R3-A typed-asleep plumbing: the frontend side of the Worker's wake-intent
 * gate. While the team sandbox sleeps, PASSIVE requests come back as a typed
 * `ContainerAsleep` 503 instead of waking it. This module owns:
 *
 * - `CompanionAsleepError` — the typed error `companionInvoke` throws so React
 *   Query can skip retries and keep showing previous data (no error dialogs).
 * - a global "asleep" signal for the ONE light staleness indicator in the
 *   sidebar (per-query staleness badges were ruled out as overkill).
 * - the micro-write queue: tiny state writes (read/unread marks, pins, drafts)
 *   are queued locally instead of waking the container, then replayed on the
 *   next wake. In-memory only — losing it on app restart re-shows an unread
 *   dot at worst (all entries are idempotent), which is the accepted trade
 *   for never waking a sandbox to clear a green dot.
 */

export class CompanionAsleepError extends Error {
	readonly asleep = true;
	readonly code = "ContainerAsleep";

	constructor(message?: string) {
		super(
			message ??
				"The team sandbox is asleep — showing last-known data until it wakes.",
		);
		this.name = "CompanionAsleepError";
	}
}

export function isCompanionAsleepError(
	error: unknown,
): error is CompanionAsleepError {
	return error instanceof CompanionAsleepError;
}

/** Recognize the Worker's typed asleep payload (`{code: "ContainerAsleep"}`). */
export function isAsleepPayload(payload: unknown): boolean {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { code?: unknown }).code === "ContainerAsleep"
	);
}

// ---------------------------------------------------------------------------
// Global asleep signal (drives the sidebar staleness indicator)
// ---------------------------------------------------------------------------

let companionAsleep = false;
const asleepListeners = new Set<() => void>();

export function setCompanionAsleep(asleep: boolean): void {
	if (companionAsleep === asleep) return;
	companionAsleep = asleep;
	for (const listener of asleepListeners) listener();
}

export function isCompanionAsleep(): boolean {
	return companionAsleep;
}

/** `useSyncExternalStore`-shaped subscription for the sidebar indicator. */
export function subscribeCompanionAsleep(listener: () => void): () => void {
	asleepListeners.add(listener);
	return () => asleepListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Micro-write queue
// ---------------------------------------------------------------------------

/** PASSIVE micro-writes that queue while the sandbox sleeps. Keyed by the
 *  semantic slot the write occupies — a later write to the same slot replaces
 *  the earlier one (last-writer-wins), so replay never flip-flops state. */
const MICRO_WRITE_SLOTS: Record<
	string,
	(args: Record<string, unknown>) => string
> = {
	mark_session_read: (a) => `session-read:${a.sessionId}`,
	mark_session_unread: (a) => `session-read:${a.sessionId}`,
	mark_workspace_unread: (a) => `workspace-read:${a.workspaceId}`,
	pin_workspace: (a) => `workspace-pin:${a.workspaceId}`,
	unpin_workspace: (a) => `workspace-pin:${a.workspaceId}`,
	move_workspace_in_sidebar: (a) => `workspace-move:${a.workspaceId}`,
	move_repository_in_sidebar: (a) => `repo-move:${a.repoId ?? a.repositoryId}`,
	set_session_draft: (a) => `session-draft:${a.sessionId}`,
	set_session_context_usage: (a) => `session-context:${a.sessionId}`,
};

/** Ephemeral signals: silently dropped while asleep — replaying a stale
 *  presence after wake would be actively wrong. */
const DROP_WHEN_ASLEEP = new Set(["report_presence"]);

const MICRO_WRITE_QUEUE_LIMIT = 100;

export type QueuedMicroWrite = { cmd: string; args: Record<string, unknown> };

let microWriteQueue: QueuedMicroWrite[] = [];

export function isQueueableMicroWrite(cmd: string): boolean {
	return cmd in MICRO_WRITE_SLOTS;
}

export function shouldDropWhenAsleep(cmd: string): boolean {
	return DROP_WHEN_ASLEEP.has(cmd);
}

/** Queue a micro-write for replay on the next wake. Last-writer-wins per
 *  semantic slot; bounded drop-oldest overflow. */
export function queueMicroWrite(
	cmd: string,
	args: Record<string, unknown>,
): void {
	const slot = MICRO_WRITE_SLOTS[cmd]?.(args);
	if (slot !== undefined) {
		microWriteQueue = microWriteQueue.filter(
			(entry) => MICRO_WRITE_SLOTS[entry.cmd]?.(entry.args) !== slot,
		);
	}
	microWriteQueue.push({ cmd, args });
	if (microWriteQueue.length > MICRO_WRITE_QUEUE_LIMIT) {
		const dropped = microWriteQueue.shift();
		console.warn(
			`[asleep-queue] overflow (> ${MICRO_WRITE_QUEUE_LIMIT}): dropped oldest ${dropped?.cmd}`,
		);
	}
}

/** Take the whole queue for replay. Entries that fail again (still asleep)
 *  should be re-queued by the caller via {@link queueMicroWrite}. */
export function drainMicroWrites(): QueuedMicroWrite[] {
	const drained = microWriteQueue;
	microWriteQueue = [];
	return drained;
}

/** Test-only reset. */
export function resetCompanionAsleepForTests(): void {
	companionAsleep = false;
	asleepListeners.clear();
	microWriteQueue = [];
}
