import { useEffect } from "react";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { Button } from "@/components/ui/button";
import { isTeamModeActive } from "@/lib/team-mode";
import {
	ensureTeamReadinessProbe,
	retryTeamReadiness,
	useTeamReadiness,
} from "@/lib/team-readiness";
import { switchTeamMode } from "@/lib/team-switch";
import { useTransportGeneration } from "@/lib/transport-generation";
import { publishShellEvent } from "@/shell/event-bus";

/**
 * Full-window frosted-glass gate shown until Team readiness reaches `ready`.
 *
 * WP1 (team-cloud-stabilize): derives ENTIRELY from the single team-readiness
 * state machine ({@link useTeamReadiness}). A stale config or a
 * previously-established team can no longer skip it ("秒连" / S1) — every entry
 * runs the health probe, and the overlay stays up until `ready`. A cold
 * Cloudflare sandbox can take ~1–2 min to wake, so this shows the live connecting
 * stage; a `degraded` verdict shows a terminal (`unauthorized`) or retryable
 * error with a Retry, and always a "Back to Local" escape so the user is never
 * trapped behind the blur.
 */
export function TeamConnectingOverlay() {
	// Re-render after a Local↔Team switch so `isTeamModeActive()` re-reads the
	// flipped state (same subscription the team switch/panel use).
	useTransportGeneration();
	const readiness = useTeamReadiness();
	const teamActive = isTeamModeActive();

	// A reload straight into team mode never calls `switchTeamMode`, so no probe
	// was kicked — start one on mount (idempotent: a no-op while one is live or
	// we're already `ready`) so the gate resolves instead of spinning forever.
	useEffect(() => {
		if (teamActive) ensureTeamReadinessProbe();
	}, [teamActive]);

	if (!teamActive || readiness.state === "ready") return null;

	const degraded = readiness.state === "degraded";
	const unauthorized = readiness.unauthorized;
	const headline = readiness.label || "Connecting to team cloud…";
	const detail =
		readiness.detail ||
		"Waking your team's Cloudflare sandbox. A cold start can take a minute.";

	return (
		<div
			className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-background/20 backdrop-blur-sm"
			role="status"
			aria-live="polite"
		>
			<HelmorLogoAnimated size={72} />
			<div className="flex max-w-xs flex-col items-center gap-1 text-center">
				<p className="font-medium">{headline}</p>
				<p className="text-mini text-muted-foreground leading-tight">
					{detail}
				</p>
			</div>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={() => switchTeamMode(null)}
				>
					Back to Local
				</Button>
				{degraded && !unauthorized ? (
					<Button size="sm" onClick={() => retryTeamReadiness()}>
						Retry
					</Button>
				) : null}
				{degraded ? (
					<Button
						variant={unauthorized ? "default" : "outline"}
						size="sm"
						onClick={() =>
							publishShellEvent({ type: "open-settings", section: "team" })
						}
					>
						Open Team settings
					</Button>
				) : null}
			</div>
		</div>
	);
}
