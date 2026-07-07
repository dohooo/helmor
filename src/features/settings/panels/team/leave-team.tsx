import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { clearTeamConfig } from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";

/**
 * The Leave-team escape hatch (R5-A 裁决⑤). With manual Worker URL / token /
 * Reset all gone from settings, this low-key link is how a member who joined
 * the wrong team gets out: confirm → wipe the saved team config (including
 * the query-cache bucket) → switch the live transport back to local.
 *
 * Lives at the bottom of Settings → Team (not the invite modal) because
 * members — the ones who most need an exit — never see the invite modal.
 */
export function LeaveTeamRow() {
	const [confirming, setConfirming] = useState(false);

	const leave = () => {
		// Wipe config first (also clears the admin token + cached email and
		// deletes the team's query-cache bucket), then repoint the transport —
		// `switchTeamMode(null)` flips the flag and remounts onto local.
		clearTeamConfig();
		switchTeamMode(null);
	};

	return (
		<div className="mt-4">
			<button
				type="button"
				onClick={() => setConfirming(true)}
				className="cursor-pointer text-small text-muted-foreground hover:text-foreground hover:underline"
			>
				Leave this team…
			</button>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Leave this team?"
				description="Helmor switches back to local mode. Your local workspaces stay untouched — you can rejoin anytime with an invite link."
				confirmLabel="Leave team"
				onConfirm={leave}
			/>
		</div>
	);
}
