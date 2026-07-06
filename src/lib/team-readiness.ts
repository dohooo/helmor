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
 * The probe polls the Worker's `/rpc/list_agent_model_sections` (WP5): the
 * Worker answers it from its control-plane D1 cache WITHOUT waking the
 * container, so one request answers three things — Worker reachable, token
 * valid, model catalog available — and a sleeping container is `ready` in
 * milliseconds (the previous `/v1/health` probe proxied through ensureServe
 * and itself triggered a cold start). It never throws:
 *   - 200            → ready (control plane answered; models are available).
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

// R3-D: consecutive WAKE-request failures. The probe's catalog check is a
// CONTROL-PLANE answer (Worker + D1) — it says nothing about whether the
// container can actually be woken. During the restore-OOM P0 the catalog
// kept answering 200 while every wake died, so the UI sat on "Connected"
// over a dead backend. Track wake outcomes reported by the transport: after
// N consecutive failures, degrade readiness (and hold the probe's `ready`
// verdict) until a wake SUCCEEDS again.
const WAKE_FAILURE_DEGRADE_THRESHOLD = 3;
let consecutiveWakeFailures = 0;

function wakeWedged(): boolean {
	return consecutiveWakeFailures >= WAKE_FAILURE_DEGRADE_THRESHOLD;
}

function degradedWakeWedged(detail?: string): TeamReadiness {
	return {
		state: "degraded",
		label: "The team sandbox isn't waking",
		detail:
			detail ||
			"The backend answers, but the container fails to start (its data snapshot may be failing to restore). Retry, or check Team settings.",
		unauthorized: false,
	};
}

/** Report the outcome of a WAKE-classified request (transport calls this). */
export function reportWakeOutcome(ok: boolean, detail?: string): void {
	if (ok) {
		consecutiveWakeFailures = 0;
		return;
	}
	consecutiveWakeFailures += 1;
	if (wakeWedged() && current.state === "ready") {
		set(degradedWakeWedged(detail));
	}
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

/** The Worker reported a PERMANENT container-start failure (bad image / limits /
 *  crash-loop). Retries against the same backend won't help, so degrade FAST
 *  rather than polling the 180s cold-start ceiling — but stay retryable (not
 *  `unauthorized`): re-running Team setup / redeploying can fix it (WP6). */
const degradedPermanent = (detail?: string): TeamReadiness => ({
	state: "degraded",
	label: "The team sandbox can't start",
	detail:
		detail?.trim() ||
		"Its container is failing to boot (a permanent error). Re-run Team setup, or check the sandbox image + Cloudflare Containers plan in Settings → Team.",
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
				// WP5 readiness probe: answered by the Worker's D1 model-catalog
				// cache with the container ASLEEP (no ensureServe). A cache miss
				// (brand-new/reset team) falls through to a real cold start on the
				// Worker side — the 503 staging below covers that path.
				const res = await fetch(`${base}/rpc/list_agent_model_sections`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(config.token
							? { Authorization: `Bearer ${config.token}` }
							: {}),
					},
					body: "{}",
					signal: controller.signal,
				});
				if (gen !== probeGen) return;
				// Got an HTTP response → the Worker is reachable; reset the
				// network-error clock (a 503 is a cold start, not unreachable).
				firstNetworkErrorAt = null;
				if (res.ok) {
					// R3-D: a catalog 200 is control-plane-only evidence. While
					// wakes are wedged, `ready` would be a lie — stay degraded
					// until a wake succeeds (which resets the counter).
					set(wakeWedged() ? degradedWakeWedged() : READY);
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
					permanent?: boolean;
				};
				// A PERMANENT container-start failure (Worker-tagged) won't clear
				// with retries — degrade FAST instead of showing a cold-start
				// stage (WP6, fixes S1/S3 "stuck connecting" on a dead backend).
				if (body.permanent) {
					set(degradedPermanent(body.message));
					return;
				}
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
	consecutiveWakeFailures = 0;
	set(idle());
}

/** Retry after `degraded`. Same as {@link beginTeamReadinessProbe}. */
export function retryTeamReadiness(): void {
	// An explicit user retry forgives past wake failures — otherwise the
	// wedged-degraded verdict is unescapable (the overlay blocks the very
	// interactions that could produce a successful wake).
	consecutiveWakeFailures = 0;
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
