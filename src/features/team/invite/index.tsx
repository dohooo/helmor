import { UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getTeamAdminToken, isTeamModeActive } from "@/lib/team-mode";
import { InviteModal } from "./invite-modal";

/**
 * Sidebar Invite button (R5-A 裁决⑥) — the admin's one-click way to bring a
 * teammate in. Renders ONLY on the team creator's machine (team mode active
 * AND the companion/admin token stored at create time); members get nothing,
 * not a disabled button. Clicking opens the invite modal, which mints a
 * fresh link immediately — no separate "Mint" step.
 */
export function InviteButton() {
	const [open, setOpen] = useState(false);
	if (!isTeamModeActive() || getTeamAdminToken() === null) return null;

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => setOpen(true)}
						aria-label="Invite a teammate"
						className="text-muted-foreground hover:text-foreground"
					>
						<UserPlus className="size-[15px]" strokeWidth={1.8} />
					</Button>
				</TooltipTrigger>
				<TooltipContent
					side="bottom"
					className="flex h-[24px] items-center rounded-md px-2 text-small leading-none"
				>
					Invite a teammate
				</TooltipContent>
			</Tooltip>
			<InviteModal open={open} onOpenChange={setOpen} />
		</>
	);
}
