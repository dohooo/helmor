import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { Button } from "@/components/ui/button";
import { isTeamModeActive } from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";
import { useTransportGeneration } from "@/lib/transport-generation";
import { publishShellEvent } from "@/shell/event-bus";
import { useCompanionConnectionStatus } from "@/shell/hooks/use-companion-connection-status";

/**
 * Full-window frosted-glass overlay shown while Team mode is connecting to the
 * shared cloud backend. A cold Cloudflare sandbox can take ~1–2 min to wake, so
 * the Local→Team switch needs to FEEL like a real connection instead of a dead
 * UI — this replaces the removed reconnecting banner with a clear "connecting"
 * surface (animated Helmor mark + status). Gated on Team mode + a non-online
 * connection phase: renders null in Local mode and the moment we're online.
 *
 * Always offers a "Back to Local" escape so the user is never trapped behind the
 * blur; once the connect has clearly stalled (`disconnected`) it also points at
 * Team settings.
 */
export function TeamConnectingOverlay() {
	// Re-render after a Local↔Team switch so `isTeamModeActive()` re-reads the
	// flipped state (same subscription the team switch/panel use).
	useTransportGeneration();
	const { phase } = useCompanionConnectionStatus();

	if (!isTeamModeActive() || phase === "online") return null;

	const stalled = phase === "disconnected";

	return (
		<div
			className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-background/70 backdrop-blur-xl"
			role="status"
			aria-live="polite"
		>
			<HelmorLogoAnimated size={72} />
			<div className="flex max-w-xs flex-col items-center gap-1 text-center">
				<p className="font-medium">
					{stalled ? "Can't reach the team cloud" : "Connecting to team cloud…"}
				</p>
				<p className="text-mini text-muted-foreground leading-tight">
					{stalled
						? "The cloud sandbox isn't responding. It may still be waking — wait a little, or switch back to Local."
						: "Waking your team's Cloudflare sandbox. A cold start can take a minute."}
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
				{stalled ? (
					<Button
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
