import { Copy, Loader2, Mail, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TeamConfig } from "@/lib/team-mode";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../../components/settings-row";
import { useTeamAdmin } from "./use-team-admin";

/**
 * Settings → Team "Team admin" panel (Preview A).
 *
 * Two admin-only writes against the team control plane: create the single team
 * (`POST /team/bootstrap`) and mint an invite link (`POST /team/invite`). Both
 * routes are admin-gated — they only succeed when the saved bearer is the
 * companion/admin token — so a 401 is surfaced as a "not an admin token" hint.
 *
 * Write-only: there is NO status read. The minted invite URL is a capability
 * secret — it is rendered only after an explicit Mint click (never auto-fetched
 * or logged).
 *
 * This outer gate calls NO hooks and returns `null` outside team mode, so the
 * inner content never mounts in the local single-user path — single-user /
 * native byte-for-byte unchanged.
 */
export function TeamAdminPanel() {
	const cfg = isTeamModeActive() ? getTeamConfig() : null;
	if (!cfg) return null;
	return <TeamAdminPanelContent cfg={cfg} />;
}

function TeamAdminPanelContent({ cfg }: { cfg: TeamConfig }) {
	const { createTeam, mintInvite } = useTeamAdmin(cfg);

	return (
		<SettingsGroup>
			<SettingsRow
				align="start"
				title={
					<span className="flex items-center gap-1.5">
						<UserPlus className="size-4 text-muted-foreground" />
						Create team
					</span>
				}
				description={
					<>
						<div>
							Bootstrap the shared team in the control plane. Requires the
							companion/admin token (set above) — an ordinary invite token can't
							create a team.
						</div>
						{createTeam.isSuccess ? (
							<SettingsNotice tone="ok" className="mt-2">
								Team is ready.
							</SettingsNotice>
						) : null}
						{createTeam.isError ? (
							<SettingsNotice tone="warn" className="mt-2">
								{errorMessage(createTeam.error)}
							</SettingsNotice>
						) : null}
					</>
				}
			>
				<Button
					variant="outline"
					size="sm"
					onClick={() => createTeam.mutate()}
					disabled={createTeam.isPending}
					className="cursor-pointer"
				>
					{createTeam.isPending ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<UserPlus className="size-3.5" />
					)}
					{createTeam.isPending ? "Creating…" : "Create team"}
				</Button>
			</SettingsRow>

			<SettingsRow
				align="start"
				title={
					<span className="flex items-center gap-1.5">
						<Mail className="size-4 text-muted-foreground" />
						Invite a teammate
					</span>
				}
				description={
					<>
						<div>
							Mint a one-time invite link your teammate pastes into Settings →
							Team to join with their GitHub identity. The link is a capability
							secret — share it directly and don't post it publicly.
						</div>
						{mintInvite.data ? <InviteLink url={mintInvite.data.url} /> : null}
						{mintInvite.isError ? (
							<SettingsNotice tone="warn" className="mt-2">
								{errorMessage(mintInvite.error)}
							</SettingsNotice>
						) : null}
					</>
				}
			>
				<Button
					variant="outline"
					size="sm"
					onClick={() => mintInvite.mutate()}
					disabled={mintInvite.isPending}
					className="cursor-pointer"
				>
					{mintInvite.isPending ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<Mail className="size-3.5" />
					)}
					{mintInvite.isPending ? "Minting…" : "Mint invite"}
				</Button>
			</SettingsRow>
		</SettingsGroup>
	);
}

/** The minted invite URL, shown read-only with a Copy button. Rendered only
 *  after an explicit Mint — the URL is a capability secret (never logged). */
function InviteLink({ url }: { url: string }) {
	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast.success("Invite link copied");
		} catch {
			toast.error("Couldn't copy the invite link");
		}
	};

	return (
		<div className="mt-3 flex items-center gap-2">
			<Input
				readOnly
				value={url}
				aria-label="Invite link"
				className="font-mono text-mini"
				onFocus={(event) => event.currentTarget.select()}
			/>
			<Button
				variant="outline"
				size="icon-sm"
				onClick={() => void handleCopy()}
				aria-label="Copy invite link"
				className="cursor-pointer"
			>
				<Copy className="size-3.5" />
			</Button>
		</div>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong.";
}
