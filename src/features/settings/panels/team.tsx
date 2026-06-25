import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInviteAccept } from "@/features/team/use-invite-accept";
import { useTeamIdentity } from "@/features/team/use-team-identity";
import {
	getDevTeamDefault,
	getTeamConfig,
	parseInviteLink,
	pingTeamBackend,
} from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";
import { SettingsGroup, SettingsRow } from "../components/settings-row";

/**
 * Team settings. The everyday paths now live elsewhere — the workspace-location
 * switch (sidebar) flips Local↔Team and, when unconfigured, opens the Join /
 * Create setup card. This panel keeps two things:
 *   - Join with an invite link (handy from settings too).
 *   - Advanced: point Helmor at a team backend by hand (Worker URL + token +
 *     Connect), for power users / debugging. There's no Team-mode toggle here
 *     anymore — switching is the workspace-location switch's job.
 */
export function TeamPanel() {
	// In a dev build, pre-fill the fixed local `dev:team` URL + token so manual
	// connect needs zero typing (production stores nothing here).
	const initial = getTeamConfig() ?? getDevTeamDefault();
	const [url, setUrl] = useState(initial?.url ?? "");
	const [token, setToken] = useState(initial?.token ?? "");
	const [testing, setTesting] = useState(false);
	const [inviteLink, setInviteLink] = useState("");
	const { identity, isLoading: identityLoading } = useTeamIdentity();
	const { status: acceptStatus, accept } = useInviteAccept();
	const joining = acceptStatus === "accepting";

	const handleJoinWithInvite = async () => {
		const invite = parseInviteLink(inviteLink);
		if (!invite) {
			toast.error("That doesn't look like a valid invite link");
			return;
		}
		if (!identity) {
			// The forge-account roster fans out a `gh api /user` per account, so
			// it can still be in flight when this panel first opens. Don't mistake
			// "still loading" for "no GitHub account" — that misfires the
			// connect-an-account error even though one is present.
			toast.error(
				identityLoading
					? "Still loading your GitHub account — try again in a moment."
					: "Connect a GitHub account first (Settings → Accounts)",
			);
			return;
		}
		// On success the hook persists config and switches into team mode in
		// place (no reload). On failure it returns the message as a toast.
		const outcome = await accept(invite, identity);
		if (!outcome.ok && outcome.error) toast.error(outcome.error);
	};

	const handleTest = async () => {
		setTesting(true);
		try {
			const ok = await pingTeamBackend(url, token);
			if (ok) {
				toast.success("Connected to the team backend");
			} else {
				toast.error("Could not reach the team backend");
			}
		} finally {
			setTesting(false);
		}
	};

	const handleConnect = () => {
		// Empty fields fall back to the dev default (dev builds only) so Connect
		// alone brings up Team mode with no typing.
		const effective = url.trim() ? { url, token } : getDevTeamDefault();
		if (!effective) {
			toast.error("Enter a Worker URL first");
			return;
		}
		// Repoint the IPC transport in place — no reload. The connecting overlay
		// covers a cold backend waking up. (Switch back to Local from the
		// workspace-location switch.)
		switchTeamMode(effective);
	};

	return (
		<div className="flex flex-col gap-5">
			<SettingsGroup>
				<SettingsRow
					title="Join with invite link"
					description="Paste an invite link to register with your GitHub identity and switch to the team workspace instantly."
					align="start"
				>
					<div className="flex items-center gap-2">
						<Input
							value={inviteLink}
							onChange={(event) => setInviteLink(event.target.value)}
							placeholder="https://…/?invite=…"
							className="w-[280px]"
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							disabled={joining}
						/>
						<Button
							size="sm"
							onClick={() => void handleJoinWithInvite()}
							disabled={joining || identityLoading || !inviteLink.trim()}
						>
							{joining ? "Joining…" : "Join"}
						</Button>
					</div>
				</SettingsRow>
			</SettingsGroup>

			<div>
				<h3 className="font-medium text-muted-foreground text-small">
					Advanced
				</h3>
				<p className="mt-0.5 text-mini text-muted-foreground leading-tight">
					Point Helmor at a team backend by hand. Most people use “Create a
					team” from the workspace-location switch instead.
				</p>
			</div>

			<SettingsGroup>
				<SettingsRow
					title="Worker URL"
					description="The Cloudflare Worker that fronts your team's sandbox"
					align="start"
				>
					<Input
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://helmor-team.example.workers.dev"
						className="w-[280px]"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
					/>
				</SettingsRow>

				<SettingsRow
					title="Access token"
					description="The capability token your team backend accepts"
					align="start"
				>
					<Input
						type="password"
						value={token}
						onChange={(event) => setToken(event.target.value)}
						placeholder="hlm_…"
						className="w-[280px]"
						autoComplete="off"
						spellCheck={false}
					/>
				</SettingsRow>

				<SettingsRow
					title="Connection"
					description="Test the backend is reachable, then connect with the URL + token above."
				>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => void handleTest()}
							disabled={testing || !url.trim()}
						>
							{testing ? "Testing…" : "Test"}
						</Button>
						<Button size="sm" onClick={handleConnect} disabled={!url.trim()}>
							Connect
						</Button>
					</div>
				</SettingsRow>
			</SettingsGroup>
		</div>
	);
}
