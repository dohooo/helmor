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
}

const POLL_GAP_MS = 3000;
const POLL_TIMEOUT_MS = 10_000;

function mapStatus(status: number, message: string): TeamConnectStage {
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
					setStage(mapStatus(res.status, body.message ?? ""));
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
