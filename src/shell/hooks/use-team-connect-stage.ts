import { useEffect, useState } from "react";
import { getTeamConfig } from "@/lib/team-mode";

/**
 * A friendly, LIVE connection stage derived by polling the team Worker's
 * `/v1/health` while the connecting overlay is up — so the user sees WHICH step
 * a cold start is on (waking the container → starting the serve host → up)
 * instead of a static spinner.
 *
 * The Worker answers `/v1/health` with structured status during a cold start:
 * it holds/booting → `503 {message:"serve host not ready: …"}` → `200 {status:
 * "ok"}`. We map those to plain-language stages. The poll also nudges the cold
 * start (hitting the route wakes the container), and never throws — a failed /
 * timed-out probe just reads as "waking".
 */
export interface TeamConnectStage {
	label: string;
	detail: string;
	/** Terminal auth failure (401/403): the saved team token is invalid — not a
	 *  transient cold-start — so the overlay shows a terminal "re-join" state
	 *  instead of spinning "Connecting…" forever. */
	unauthorized?: boolean;
}

const POLL_GAP_MS = 3000;
const POLL_TIMEOUT_MS = 10_000;

function mapStatus(status: number, message: string): TeamConnectStage {
	// 401/403 = the saved team token is invalid (removed from the team, or the
	// team was reset). Terminal — NOT a cold-start — so the overlay must stop
	// "connecting" and offer a re-join / Back-to-Local escape.
	if (status === 401 || status === 403) {
		return {
			label: "Team access not authorized",
			detail:
				"Your team token is no longer valid — you may have been removed from the team, or it was reset. Re-join the team, or go back to Local.",
			unauthorized: true,
		};
	}
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

export function useTeamConnectStage(active: boolean): TeamConnectStage | null {
	const [stage, setStage] = useState<TeamConnectStage | null>(null);

	useEffect(() => {
		if (!active) {
			setStage(null);
			return;
		}
		const config = getTeamConfig();
		if (!config) return;
		const base = config.url.replace(/\/+$/, "");

		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const tick = async () => {
			if (cancelled) return;
			const controller = new AbortController();
			const abort = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
			try {
				const res = await fetch(`${base}/v1/health`, {
					headers: config.token
						? { Authorization: `Bearer ${config.token}` }
						: {},
					signal: controller.signal,
				});
				if (cancelled) return;
				if (res.ok) {
					setStage({
						label: "Sandbox is up — finishing the connection…",
						detail: "Almost there.",
					});
				} else {
					const body = (await res.json().catch(() => ({}))) as {
						message?: string;
					};
					const next = mapStatus(res.status, body.message ?? "");
					setStage(next);
					// Terminal auth failure: stop polling — the token won't fix
					// itself, and each /v1/health probe wakes the container (cost).
					// A re-join resets the transport + remounts this hook.
					if (next.unauthorized) cancelled = true;
				}
			} catch {
				if (!cancelled) {
					setStage({
						label: "Waking the sandbox…",
						detail: "Cold start — this can take a minute.",
					});
				}
			} finally {
				clearTimeout(abort);
				if (!cancelled) {
					timer = setTimeout(() => void tick(), POLL_GAP_MS);
				}
			}
		};

		void tick();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [active]);

	return stage;
}
