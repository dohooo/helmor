/**
 * R2-A: shared "companion idle-suspended" signal.
 *
 * `use-companion-idle-suspend` drops the shared `/v1/stream` + pauses React
 * Query polls when the app is unattended (hidden 60s / visible-idle 10m) so
 * the remote sandbox can idle-sleep. With rpc-stream keepalives (R2-A) a live
 * watch stream would now pin the sandbox awake forever, so watch
 * subscriptions must ride the SAME signal: detach on suspend, reattach on
 * resume. Cost-neutral while attended — the 10s git-status poll already keeps
 * the sandbox awake in that window.
 *
 * Module-level store (writer: the idle-suspend hook; readers: `api.ts`
 * subscription lifecycles + tests).
 */

let suspended = false;
const listeners = new Set<() => void>();

export function setCompanionIdleSuspended(value: boolean): void {
	if (suspended === value) return;
	suspended = value;
	for (const listener of listeners) listener();
}

export function isCompanionIdleSuspended(): boolean {
	return suspended;
}

export function subscribeCompanionIdleSuspended(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
