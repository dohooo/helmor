/**
 * Team readiness — the SINGLE state machine that gates entry into Team mode.
 *
 * WP1 (team-cloud-stabilize): replaces the scattered gating — a localStorage
 * flag ({@link isTeamModeActive}), a `teamEverEstablished` "online" seed that
 * skipped the connect check, and the overlay's own ad-hoc `/v1/health` poll —
 * with ONE source of truth every team gate derives from. `switchTeamMode` can
 * only enter `connecting`; this probe decides `ready` vs `degraded`.
 *
 *   unconfigured → connecting → ready
 *                            -> degraded (retryable, or terminal `unauthorized`)
 *
 * The probe polls the Worker's public `/v1/health` (WP5 will fold the model
 * catalog into the same probe as a stronger readiness signal). It never throws:
 *   - 200            → ready (the Worker + container are up).
 *   - 401/403        → degraded + `unauthorized` (invalid token; terminal).
 *   - 503 "not ready"→ connecting (a legit cold start) until the cold-start
 *                       ceiling, then degraded.
 *   - network error  → the Worker itself is unreachable (offline / wrong URL),
 *                       NOT a cold start → degrade fast.
 *
 * Module-level (not a hook) so it survives the transport remount and stays a
 * single source; consumers read it through {@link useTeamReadiness}.
 */
import { useSyncExternalStore } from "react";
import { getTeamConfig } from "./team-mode";

export type TeamReadinessState =
	| "unconfigured"
	| "connecting"
	| "ready"
	| "degraded";

export interface TeamReadiness {
	state: TeamReadinessState;
	/** Plain-language headline for the connecting / degraded surface. */
	label: string;
	detail: string;
	/** Terminal auth failure: the saved token is invalid (removed from the team,
	 *  or the team was reset). `retryTeamReadiness()` won't fix it — the user must
	 *  re-join or go back to Local. */
	unauthorized: boolean;
}

const POLL_GAP_MS = 3_000;
const POLL_TIMEOUT_MS = 10_000;
/** A 503 "serve host not ready" is a legit cold start; stay `connecting` until
 *  this ceiling (matches the Worker's SERVE_READY_TIMEOUT_MS) before degrading. */
const COLD_START_CEILING_MS = 180_000;
/** A pure network error means the Worker is unreachable (offline / wrong URL),
 *  not a cold start — degrade after this much continuous failure. */
const UNREACHABLE_AFTER_MS = 15_000;

const CONNECTING: TeamReadiness = {
	state: "connecting",
	label: "Connecting to team cloud…",
	detail:
		"Waking your team's Cloudflare sandbox. A cold start can take a minute.",
	unauthorized: false,
};

const READY: TeamReadiness = {
	state: "ready",
	label: "",
	detail: "",
	unauthorized: false,
};

function idle(): TeamReadiness {
	return getTeamConfig()
		? CONNECTING
		: { state: "unconfigured", label: "", detail: "", unauthorized: false };
}

let current: TeamReadiness = idle();
const listeners = new Set<() => void>();

function equal(a: TeamReadiness, b: TeamReadiness): boolean {
	return (
		a.state === b.state &&
		a.label === b.label &&
		a.detail === b.detail &&
		a.unauthorized === b.unauthorized
	);
}

function set(next: TeamReadiness): void {
	if (equal(current, next)) return;
	current = next;
	for (const listener of listeners) listener();
}

// A monotonically increasing token identifies the live probe; bumping it aborts
// any in-flight loop (checked after every await), mirroring ipc.ts's stream
// generation. `probeLive` lets `ensureTeamReadinessProbe` avoid double-kicking.
let probeGen = 0;
let probeLive = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function coldStage(
	status: number,
	message: string,
): { label: string; detail: string } {
	const m = message.toLowerCase();
	if (m.includes("serve host not ready") || m.includes("session init")) {
		return {
			label: "Starting Helmor in the sandbox…",
			detail: "The container is up; the serve host is initializing.",
		};
	}
	if (m.includes("provision") || m.includes("starting") || m.includes("boot")) {
		return {
			label: "Booting the sandbox container…",
			detail: "Cloudflare is starting your container from the image.",
		};
	}
	return {
		label: "Connecting to the sandbox…",
		detail: message || `Sandbox responded ${status}.`,
	};
}

const degradedUnauthorized: TeamReadiness = {
	state: "degraded",
	label: "Team access not authorized",
	detail:
		"Your team token is no longer valid — you may have been removed from the team, or it was reset. Re-join the team, or go back to Local.",
	unauthorized: true,
};

const degradedUnreachable = (detail: string): TeamReadiness => ({
	state: "degraded",
	label: "Can't reach the team cloud",
	detail,
	unauthorized: false,
});

async function runProbe(gen: number): Promise<void> {
	const startedAt = Date.now();
	let firstNetworkErrorAt: number | null = null;
	try {
		while (gen === probeGen) {
			const config = getTeamConfig();
			if (!config) {
				set(idle());
				return;
			}
			const base = config.url.replace(/\/+$/, "");
			const controller = new AbortController();
			const abort = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
			try {
				const res = await fetch(`${base}/v1/health`, {
					headers: config.token
						? { Authorization: `Bearer ${config.token}` }
						: {},
					signal: controller.signal,
				});
				if (gen !== probeGen) return;
				// Got an HTTP response → the Worker is reachable; reset the
				// network-error clock (a 503 is a cold start, not unreachable).
				firstNetworkErrorAt = null;
				if (res.ok) {
					set(READY);
					return;
				}
				if (res.status === 401 || res.status === 403) {
					set(degradedUnauthorized);
					return;
				}
				if (Date.now() - startedAt > COLD_START_CEILING_MS) {
					set(
						degradedUnreachable(
							"The sandbox didn't finish starting in time. It may be misconfigured — check Team settings, or go back to Local.",
						),
					);
					return;
				}
				const body = (await res.json().catch(() => ({}))) as {
					message?: string;
				};
				set({
					state: "connecting",
					unauthorized: false,
					...coldStage(res.status, body.message ?? ""),
				});
			} catch {
				if (gen !== probeGen) return;
				if (firstNetworkErrorAt === null) firstNetworkErrorAt = Date.now();
				if (Date.now() - firstNetworkErrorAt > UNREACHABLE_AFTER_MS) {
					set(
						degradedUnreachable(
							"No response from the team backend — it may be offline, or the URL is wrong. Check Team settings, or go back to Local.",
						),
					);
					return;
				}
				set({
					state: "connecting",
					label: "Waking the sandbox…",
					detail: "Cold start — this can take a minute.",
					unauthorized: false,
				});
			} finally {
				clearTimeout(abort);
			}
			await sleep(POLL_GAP_MS);
		}
	} finally {
		// Only clear if we're still the current probe (a superseding probe owns it).
		if (gen === probeGen) probeLive = false;
	}
}

/** Enter `connecting` and (re)start the probe. Called by `switchTeamMode` on a
 *  Local→Team switch, and by {@link retryTeamReadiness}. Aborts any prior probe. */
export function beginTeamReadinessProbe(): void {
	probeGen += 1;
	const gen = probeGen;
	if (!getTeamConfig()) {
		probeLive = false;
		set(idle());
		return;
	}
	probeLive = true;
	set(CONNECTING);
	void runProbe(gen);
}

/** Stop probing and return to the idle state (unconfigured, or connecting seed
 *  if a config lingers). Called by `switchTeamMode(null)` on Team→Local. */
export function resetTeamReadiness(): void {
	probeGen += 1;
	probeLive = false;
	set(idle());
}

/** Retry after `degraded`. Same as {@link beginTeamReadinessProbe}. */
export function retryTeamReadiness(): void {
	beginTeamReadinessProbe();
}

/** Ensure a probe is running when we're already in team mode but none was
 *  kicked (e.g. a reload straight into team mode). Idempotent: a no-op while a
 *  probe is live or we're already `ready`. Consumers call this on mount. */
export function ensureTeamReadinessProbe(): void {
	if (!getTeamConfig()) {
		set(idle());
		return;
	}
	if (probeLive || current.state === "ready") return;
	beginTeamReadinessProbe();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The current team readiness — the single gate all team UI derives from. */
export function useTeamReadiness(): TeamReadiness {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => current,
	);
}

/** Non-hook read (for imperative call sites / tests). */
export function getTeamReadiness(): TeamReadiness {
	return current;
}
