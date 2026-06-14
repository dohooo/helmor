import { useState } from "react";
import {
	clearInviteFromLocation,
	getInviteFromLocation,
	isTeamModeActive,
	type ParsedInvite,
} from "@/lib/team-mode";
import { InviteAcceptDialog } from "./invite-accept-dialog";

/**
 * Reads a team invite out of the launch URL (`?invite=<token>`) once at
 * mount and, when present, raises the {@link InviteAcceptDialog}. Renders
 * nothing in the common (no-invite) case.
 *
 * Skipped when team mode is already active — the user is already in a team,
 * so a leftover `?invite=` param is stale; we just strip it.
 */
export function InviteAcceptHost() {
	const [invite, setInvite] = useState<ParsedInvite | null>(() => {
		const detected = getInviteFromLocation();
		if (!detected) return null;
		if (isTeamModeActive()) {
			// Already in a team — drop the stale param, don't prompt.
			clearInviteFromLocation();
			return null;
		}
		return detected;
	});

	if (!invite) return null;
	return (
		<InviteAcceptDialog
			invite={invite}
			onDismiss={() => {
				clearInviteFromLocation();
				setInvite(null);
			}}
		/>
	);
}
