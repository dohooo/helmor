import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useInviteAccept } from "@/features/team/use-invite-accept";
import { useTeamIdentity } from "@/features/team/use-team-identity";
import {
	getDevTeamDefault,
	getTeamConfig,
	isTeamModeActive,
	parseInviteLink,
	pingTeamBackend,
} from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";
import { useTransportGeneration } from "@/lib/transport-generation";
import { SettingsGroup, SettingsRow } from "../components/settings-row";

/**
 * Team mode panel: point Helmor at a shared cloud backend (the CF Worker) and
 * switch between Local and Team. Switching repoints the IPC transport in place
 * via {@link switchTeamMode} — instant, no reload — and the shell shows a
 * "connecting" banner while a cold team backend wakes. The UI is otherwise
 * identical — "zero new concepts".
 */
export function TeamPanel() {
	// In a dev build, pre-fill the fixed local `dev:team` URL + token so Team
	// mode can be toggled with zero manual entry (production stores nothing here).
	const initial = getTeamConfig() ?? getDevTeamDefault();
	const [url, setUrl] = useState(initial?.url ?? "");
	const [token, setToken] = useState(initial?.token ?? "");
	const [testing, setTesting] = useState(false);
	const [inviteLink, setInviteLink] = useState("");
	// Subscribe to the transport generation so this panel re-renders after a
	// switch and `active` re-reads the flipped state. The panel lives inside
	// SettingsDialog, which the keyed remount may close, but this keeps the
	// toggle's `checked` correct for the moment the panel is still mounted.
	useTransportGeneration();
	const active = isTeamModeActive();
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
		// place (no reload) — so there's no follow-up here. On failure it
		// returns the message, which we surface as a toast.
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

	const handleToggle = (next: boolean) => {
		if (next) {
			// Empty fields fall back to the dev default (dev builds only) so the
			// switch alone brings up Team mode with no typing.
			const effective = url.trim() ? { url, token } : getDevTeamDefault();
			if (!effective) {
				toast.error("Enter a Worker URL first");
				return;
			}
			// Repoint the IPC transport in place — no reload. The shell shows a
			// connecting banner while a cold team backend wakes.
			switchTeamMode(effective);
		} else {
			switchTeamMode(null);
		}
	};

	return (
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

			<SettingsRow
				title="Team mode"
				description="Run against a shared cloud backend instead of this machine. Switches instantly."
			>
				<Switch
					checked={active}
					onCheckedChange={handleToggle}
					aria-label="Toggle team mode"
				/>
			</SettingsRow>

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
				description="Check the backend is reachable before switching"
			>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void handleTest()}
					disabled={testing || !url.trim()}
				>
					{testing ? "Testing…" : "Test connection"}
				</Button>
			</SettingsRow>
		</SettingsGroup>
	);
}
