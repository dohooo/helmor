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
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { isTauriRuntime } from "@/lib/platform";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";
import { publishShellEvent } from "@/shell/event-bus";

/**
 * Sidebar quick-switch between Local (this Mac's Tauri backend) and Team (a
 * shared cloud companion fronted by the CF Worker). It is the lightweight twin
 * of the Settings → Team panel: the panel owns config entry (Worker URL +
 * token + reachability test); this dropdown is the one-click flip.
 *
 * Switching repoints the IPC transport in place via {@link switchTeamMode} —
 * instant, no reload; the shell shows a connecting banner while a cold team
 * backend wakes. Selecting the mode you're already in is a no-op.
 *
 * This component renders in the sidebar, INSIDE the router subtree that remounts
 * on a switch, so `active = isTeamModeActive()` re-reads correctly after the
 * remount — no extra generation subscription needed here.
 *
 * Rendered `null` outside the Tauri runtime: a browser served by the companion
 * is already remote, and there is no local backend to toggle back to.
 */
export function TeamModeSwitch() {
	const [open, setOpen] = useState(false);

	if (!isTauriRuntime()) return null;

	const active = isTeamModeActive();
	const configured = getTeamConfig() !== null;

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
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							aria-label="Workspace location"
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground"
						>
							{active ? (
								<Cloud className="size-4" strokeWidth={2} />
							) : (
								<MonitorSmartphone className="size-4" strokeWidth={2} />
							)}
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent
					side="top"
					sideOffset={4}
					className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
				>
					<span>{active ? "Team (cloud)" : "Local (this Mac)"}</span>
				</TooltipContent>
			</Tooltip>
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
