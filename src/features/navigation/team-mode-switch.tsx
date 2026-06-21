import { Check, Cloud, MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { isTauriRuntime } from "@/lib/platform";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";
import { cn } from "@/lib/utils";
import { publishShellEvent } from "@/shell/event-bus";
import {
	type ConnectionPhase,
	useCompanionConnectionStatus,
} from "@/shell/hooks/use-companion-connection-status";

/**
 * Sidebar quick-switch between Local (this Mac's Tauri backend) and Team (a
 * shared cloud companion fronted by the CF Worker). It is the lightweight twin
 * of the Settings → Team panel: the panel owns config entry (Worker URL +
 * token + reachability test); this dropdown is the one-click flip.
 *
 * In team mode the Cloud icon is COLOR-CODED by the live connection state:
 * green (online), yellow + gentle pulse (connecting/reconnecting — a cold
 * sandbox can take up to ~2 min), red (disconnected — connecting has persisted
 * past the cold-start ceiling). The local <MonitorSmartphone> stays muted with
 * no status. A hover card surfaces the status word + backend host (and one
 * reason line when red); the same element is the dropdown trigger, so a click
 * still opens the Local/Team switch.
 *
 * Switching repoints the IPC transport in place via {@link switchTeamMode} —
 * instant, no reload. Selecting the mode you're already in is a no-op.
 *
 * This component renders in the sidebar, INSIDE the router subtree that remounts
 * on a switch, so `active = isTeamModeActive()` re-reads correctly after the
 * remount — no extra generation subscription needed here.
 *
 * Rendered `null` outside the Tauri runtime: a browser served by the companion
 * is already remote, and there is no local backend to toggle back to.
 */

/** The status word shown on hover, per derived connection phase. */
const PHASE_LABEL: Record<ConnectionPhase, string> = {
	online: "Connected",
	connecting: "Connecting…",
	reconnecting: "Reconnecting…",
	disconnected: "Disconnected",
};

/** Cloud-icon color per phase. Yellow pulses to read as "actively trying". */
function cloudToneClass(phase: ConnectionPhase): string {
	switch (phase) {
		case "online":
			return "text-status-success";
		case "disconnected":
			return "text-status-danger";
		default:
			return "text-status-warning animate-pulse";
	}
}

/** Parse the bare host out of the saved Worker URL for the hover card. Falls
 *  back to the raw value if it isn't a parseable URL. */
function teamHost(): string | null {
	const config = getTeamConfig();
	if (!config) return null;
	try {
		return new URL(config.url).host;
	} catch {
		return config.url;
	}
}

export function TeamModeSwitch() {
	const [open, setOpen] = useState(false);
	const status = useCompanionConnectionStatus();

	if (!isTauriRuntime()) return null;

	const active = isTeamModeActive();
	const configured = getTeamConfig() !== null;
	const host = teamHost();

	const selectLocal = () => {
		if (!active) return;
		switchTeamMode(null);
	};

	const selectTeam = () => {
		if (active) return;
		if (!configured) {
			// No backend yet — route to the Team settings panel so the user can
			// enter the Worker URL + token instead of flipping into a broken mode.
			publishShellEvent({ type: "open-settings", section: "team" });
			return;
		}
		// `configured` guarantees a non-null config here.
		switchTeamMode(getTeamConfig());
	};

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<HoverCard openDelay={150} closeDelay={50}>
				<HoverCardTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							aria-label="Workspace location"
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground"
						>
							{active ? (
								<Cloud
									className={cn("size-4", cloudToneClass(status.phase))}
									strokeWidth={2}
								/>
							) : (
								<MonitorSmartphone className="size-4" strokeWidth={2} />
							)}
						</Button>
					</DropdownMenuTrigger>
				</HoverCardTrigger>
				<HoverCardContent side="top" align="start" className="w-auto max-w-64">
					{active ? (
						<div className="flex flex-col gap-0.5">
							<span className="font-medium leading-none">
								{PHASE_LABEL[status.phase]}
							</span>
							{host ? (
								<span className="text-mini text-muted-foreground leading-tight">
									{host}
								</span>
							) : null}
							{status.phase === "disconnected" ? (
								<span className="text-mini text-muted-foreground leading-tight">
									Can't reach the team sandbox.
								</span>
							) : null}
						</div>
					) : (
						<span className="leading-none">Local (this Mac)</span>
					)}
				</HoverCardContent>
			</HoverCard>
			{/* Invisible live region: announce team-connection drops/recoveries to
			    assistive tech. The visual cue is icon color + hover text only, which
			    a screen reader can't perceive — this restores the announce-on-change
			    that the removed reconnecting banner provided. */}
			{active ? (
				<span className="sr-only" role="status">
					{`Team backend: ${PHASE_LABEL[status.phase]}`}
				</span>
			) : null}
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuLabel>Workspace location</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={selectLocal}>
					<MonitorSmartphone strokeWidth={2} />
					<span className="flex-1">Local</span>
					{active ? null : <Check className="size-4" strokeWidth={2.4} />}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={selectTeam}>
					<Cloud strokeWidth={2} />
					<span className="flex-1">Team</span>
					{active ? <Check className="size-4" strokeWidth={2.4} /> : null}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() =>
						publishShellEvent({ type: "open-settings", section: "team" })
					}
				>
					<span className="flex-1">Configure team backend…</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
