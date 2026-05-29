/**
 * Subscribe to the `remoteBundleInstall*` UI-mutation events and expose
 * a per-runtime "current status" snapshot for the Remote Servers row.
 *
 * The row renders a small chip based on this hook's output:
 *   - During an install: spinner + the `message` from the latest
 *     `progress` event (so the operator sees "Uploading agent runtime
 *     (3 files, 325.9 MB)" turning into "Verified checksums and
 *     committed bundle files" turning into "Restarting the remote
 *     daemon…").
 *   - After `complete{alreadyCurrent:false}`: a green "Installed in
 *     5.2s" line that fades back to neutral after a couple of seconds.
 *   - After `complete{alreadyCurrent:true}`: nothing — a no-op
 *     reinstall shouldn't shout.
 *   - After `failed`: a yellow chip with the error tooltip and a
 *     "Reinstall" affordance the row already has.
 *
 * The subscription is shared across rows via a module-level Map so a
 * panel with N runtimes opens one channel, not N.
 */

import { useEffect, useState } from "react";
import { subscribeUiMutations, type UiMutationEvent } from "@/lib/api";

export type BundleStatus =
	| { kind: "idle" }
	| { kind: "installing"; step: string; message: string }
	| {
			kind: "complete";
			alreadyCurrent: boolean;
			installedFiles: string[];
			durationMs: number;
			at: number;
	  }
	| { kind: "failed"; error: string; at: number };

const listeners = new Map<string, Set<(s: BundleStatus) => void>>();
const latest = new Map<string, BundleStatus>();
let unsubscribeShared: (() => void) | null = null;
let subscribingPromise: Promise<void> | null = null;

function notify(name: string, status: BundleStatus): void {
	latest.set(name, status);
	const set = listeners.get(name);
	if (!set) return;
	for (const cb of set) cb(status);
}

function onSharedEvent(event: UiMutationEvent): void {
	switch (event.type) {
		case "remoteBundleInstallProgress":
			notify(event.name, {
				kind: "installing",
				step: event.step,
				message: event.message,
			});
			return;
		case "remoteBundleInstallComplete":
			notify(event.name, {
				kind: "complete",
				alreadyCurrent: event.alreadyCurrent,
				installedFiles: event.installedFiles,
				durationMs: event.durationMs,
				at: Date.now(),
			});
			return;
		case "remoteBundleInstallFailed":
			notify(event.name, {
				kind: "failed",
				error: event.error,
				at: Date.now(),
			});
			return;
		default:
			return;
	}
}

async function ensureSharedSubscription(): Promise<void> {
	if (unsubscribeShared || subscribingPromise) {
		return subscribingPromise ?? Promise.resolve();
	}
	subscribingPromise = (async () => {
		try {
			unsubscribeShared = await subscribeUiMutations(onSharedEvent);
		} finally {
			subscribingPromise = null;
		}
	})();
	return subscribingPromise;
}

function teardownIfIdle(): void {
	if (listeners.size > 0) return;
	const fn = unsubscribeShared;
	unsubscribeShared = null;
	fn?.();
}

/**
 * Hook into the bundle install status for one runtime. Returns the
 * latest snapshot (or `{kind: "idle"}` if nothing's happened yet).
 */
export function useBundleStatus(runtimeName: string | null): BundleStatus {
	const [status, setStatus] = useState<BundleStatus>(() => {
		if (!runtimeName) return { kind: "idle" };
		return latest.get(runtimeName) ?? { kind: "idle" };
	});

	useEffect(() => {
		if (!runtimeName) {
			setStatus({ kind: "idle" });
			return;
		}
		// Seed with the latest cached snapshot so a row that mounts mid-
		// install picks up the current step without waiting for the next
		// event.
		const seed = latest.get(runtimeName);
		if (seed) setStatus(seed);

		let bag = listeners.get(runtimeName);
		if (!bag) {
			bag = new Set();
			listeners.set(runtimeName, bag);
		}
		bag.add(setStatus);

		void ensureSharedSubscription();

		return () => {
			const set = listeners.get(runtimeName);
			if (set) {
				set.delete(setStatus);
				if (set.size === 0) listeners.delete(runtimeName);
			}
			teardownIfIdle();
		};
	}, [runtimeName]);

	return status;
}
