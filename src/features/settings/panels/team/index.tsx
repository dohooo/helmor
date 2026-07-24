import type { TeamConfig } from "@/lib/team-mode";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import { AgentStatusCard } from "./agent-status-card";
import { LeaveTeamRow } from "./leave-team";
import { ProvisionStatusCard } from "./provision-status-card";

/**
 * Settings → Team (R5-A slim form). In team mode this is deliberately just
 * three quiet blocks — "we did it for you", not an ops cockpit:
 *
 *   1. Provision status card (read-only — what your cloud is made of)
 *   2. Agent status card (collapsed to one line when everything's fine)
 *   3. A low-key "Leave this team…" escape hatch
 *
 * Everything else the old panel carried (manual Worker URL / token entry,
 * Test/Connect, Create team, Mint invite, join-with-link) is gone: setup and
 * joining live in the workspace-location switch's setup card, and inviting
 * lives behind the sidebar Invite button (admin-only).
 *
 * The outer gate calls NO hooks outside team mode, so the local single-user
 * path stays inert (same pattern as the old panels).
 */
export function TeamPanel() {
	const cfg = isTeamModeActive() ? getTeamConfig() : null;
	if (!cfg) return <LocalModeNote />;
	return <TeamPanelContent cfg={cfg} />;
}

function TeamPanelContent({ cfg }: { cfg: TeamConfig }) {
	return (
		<div className="flex flex-col gap-6">
			<ProvisionStatusCard cfg={cfg} />
			<AgentStatusCard cfg={cfg} />
			<LeaveTeamRow />
		</div>
	);
}

/** Quiet empty state for local mode — team setup lives in the sidebar's
 *  workspace-location switch, not here. */
function LocalModeNote() {
	return (
		<div className="py-10 text-center text-small text-muted-foreground">
			Helmor is running locally. To create or join a team cloud, use the
			workspace-location switch at the top of the sidebar.
		</div>
	);
}
