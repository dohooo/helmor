/**
 * DF-R6-C: per-provider "cloud authorization is invalid" local flag.
 *
 * The status card derives its lifetime label from the DO's STORED state
 * (`accessExp`), which can't see a server-side invalidation — the card kept
 * saying "Valid for 9d" while every turn 401'd with `token_invalidated` and
 * the user found out by hitting the wall. This module is the v1 fix: when a
 * turn error carries a known auth fingerprint, flip an in-memory flag for
 * that provider so the card shows "Re-authorize needed" (overriding the
 * storage-derived lifetime), refresh the identity status query, and notify
 * the user ONCE. A successful re-authorization clears the flag.
 *
 * Deliberately in-memory + session-scoped (like the companion-asleep signal):
 * losing it on app restart just re-shows the optimistic stored state until
 * the next failing turn re-flags it. No active probing (backlogged as >v1).
 */

import type { QueryClient } from "@tanstack/react-query";
import { classifyCloudError } from "@/features/composer/cloud-error-cta";
import { isTeamModeActive } from "@/lib/team-mode";

/** Providers with a cloud identity DO behind the team Worker. */
export type CloudAuthProvider = "codex" | "claude";

const QUERY_KEY_PREFIX: Record<CloudAuthProvider, string> = {
	codex: "cloudCodexIdentity",
	claude: "cloudClaudeIdentity",
};

const DISPLAY_NAME: Record<CloudAuthProvider, string> = {
	codex: "Codex",
	claude: "Claude",
};

const invalidated = new Set<CloudAuthProvider>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of listeners) listener();
}

export function isCloudAuthInvalidated(provider: CloudAuthProvider): boolean {
	return invalidated.has(provider);
}

/** Set the flag. Returns true only when NEWLY set — the caller keys the
 *  one-shot user notification off this so repeated failing turns don't spam. */
export function markCloudAuthInvalidated(provider: CloudAuthProvider): boolean {
	if (invalidated.has(provider)) return false;
	invalidated.add(provider);
	notifyListeners();
	return true;
}

/** Clear the flag (a successful re-authorization is the recovery path). */
export function clearCloudAuthInvalidated(provider: CloudAuthProvider): void {
	if (!invalidated.delete(provider)) return;
	notifyListeners();
}

/** `useSyncExternalStore`-shaped subscription for the status card hooks. */
export function subscribeCloudAuthInvalidated(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Turn-error hook (called from the stream-event dispatcher): if the error
 * text carries a known cloud-auth fingerprint (see `classifyCloudError`),
 * flag the provider, invalidate its identity status query, and — only on the
 * first detection — hand a human message to `notify`. Inert outside team
 * mode and for providers without a cloud identity.
 */
export function noteCloudAuthTurnError(opts: {
	message: string | null | undefined;
	provider: string;
	queryClient: QueryClient;
	notify: (message: string) => void;
}): void {
	if (!isTeamModeActive()) return;
	const provider = opts.provider;
	if (provider !== "codex" && provider !== "claude") return;
	if (classifyCloudError(opts.message) !== "auth") return;

	const newlyFlagged = markCloudAuthInvalidated(provider);
	void opts.queryClient.invalidateQueries({
		queryKey: [QUERY_KEY_PREFIX[provider]],
	});
	if (newlyFlagged) {
		opts.notify(
			`${DISPLAY_NAME[provider]} authorization is invalid — re-authorize in Settings → Team.`,
		);
	}
}

/** Test-only reset. */
export function resetCloudAuthInvalidatedForTests(): void {
	invalidated.clear();
	listeners.clear();
}
