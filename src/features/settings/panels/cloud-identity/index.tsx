import { CloudCog, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloudCodexIdentityStatus } from "@/lib/team-api";
import type { TeamConfig } from "@/lib/team-mode";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../../components/settings-row";
import { isCloudIdentityExpired, useCloudIdentity } from "./use-cloud-identity";

export { CloudClaudeIdentityPanel } from "./claude-panel";

/**
 * Settings → Team "Cloud Run Identity · Codex" panel.
 *
 * Cloud sessions run Codex under a dedicated ChatGPT subscription identity
 * held server-side (a per-member `CodexIdentity` Durable Object). This panel
 * shows that identity's current status (account, access-token expiry,
 * needs-reauthorize) and offers a one-time `Authorize` flow that runs
 * `codex login` locally and uploads only the OAuth refresh/id tokens to the
 * control plane — the refresh token never touches this UI.
 *
 * This outer gate calls NO hooks and returns `null` outside team mode, so the
 * React Query read in {@link CloudIdentityPanelContent} never mounts in the
 * local single-user path — single-user / native byte-for-byte unchanged.
 */
export function CloudIdentityPanel() {
	const cfg = isTeamModeActive() ? getTeamConfig() : null;
	if (!cfg) return null;
	return <CloudIdentityPanelContent cfg={cfg} />;
}

function CloudIdentityPanelContent({ cfg }: { cfg: TeamConfig }) {
	const {
		status,
		isLoading,
		isError,
		isAuthorizing,
		needsReauthorize,
		authorize,
		refetch,
	} = useCloudIdentity(cfg);

	return (
		<SettingsGroup>
			<SettingsRow
				align="start"
				title={
					<span className="flex items-center gap-1.5">
						<CloudCog className="size-4 text-muted-foreground" />
						Cloud Run Identity · Codex
					</span>
				}
				description={
					<CloudIdentityDescription
						status={status}
						isLoading={isLoading}
						isError={isError}
						needsReauthorize={needsReauthorize}
					/>
				}
			>
				<div className="flex items-center gap-1.5">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={refetch}
						disabled={isLoading || isAuthorizing}
						aria-label="Refresh cloud identity status"
						className="cursor-pointer"
					>
						<RefreshCw
							className={isLoading ? "size-3.5 animate-spin" : "size-3.5"}
						/>
					</Button>
					<Button
						variant={needsReauthorize ? "default" : "outline"}
						size="sm"
						onClick={authorize}
						disabled={isAuthorizing}
						className="cursor-pointer"
					>
						{isAuthorizing ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<KeyRound className="size-3.5" />
						)}
						{authorizeLabel(status, isAuthorizing, needsReauthorize)}
					</Button>
				</div>
			</SettingsRow>
		</SettingsGroup>
	);
}

/** Button copy reflects the lifecycle: first-time authorize, re-authorize
 *  when bricked/expired, or "Re-authorize" to rotate a healthy identity. */
function authorizeLabel(
	status: CloudCodexIdentityStatus | undefined,
	isAuthorizing: boolean,
	needsReauthorize: boolean,
): string {
	if (isAuthorizing) return "Authorizing…";
	if (needsReauthorize) return "Re-authorize";
	if (status?.hasToken) return "Re-authorize";
	return "Authorize";
}

function CloudIdentityDescription({
	status,
	isLoading,
	isError,
	needsReauthorize,
}: {
	status: CloudCodexIdentityStatus | undefined;
	isLoading: boolean;
	isError: boolean;
	needsReauthorize: boolean;
}) {
	const intro =
		"Cloud sessions authenticate Codex with a ChatGPT subscription held in the team control plane — never stored on this machine or in the container. Authorize once to bind it.";

	if (isLoading) {
		return (
			<>
				<div>{intro}</div>
				<SettingsNotice tone="info" className="mt-2">
					<span className="flex items-center gap-1.5">
						<Loader2 className="size-3 animate-spin" />
						Checking cloud identity…
					</span>
				</SettingsNotice>
			</>
		);
	}

	if (isError) {
		return (
			<>
				<div>{intro}</div>
				<SettingsNotice tone="warn" className="mt-2">
					Couldn't reach the team control plane to read the cloud identity.
				</SettingsNotice>
			</>
		);
	}

	if (!status?.hasToken) {
		return (
			<>
				<div>{intro}</div>
				<SettingsNotice tone="info" className="mt-2">
					No cloud identity yet — authorize to enable Codex on cloud runs.
				</SettingsNotice>
			</>
		);
	}

	return (
		<>
			<div>{intro}</div>
			<div className="mt-3 grid gap-1.5">
				<IdentityLine label="Account" value={status.accountId ?? "—"} mono />
				<IdentityLine label="Access token" value={describeExpiry(status)} />
			</div>
			{needsReauthorize ? (
				<SettingsNotice tone="warn" className="mt-2">
					{status.bricked
						? "The cloud identity expired and needs to be re-authorized — cloud Codex runs will fail until you do."
						: "The access token has expired — re-authorize to refresh the cloud identity."}
				</SettingsNotice>
			) : (
				<SettingsNotice tone="ok" className="mt-2">
					Cloud Codex is authorized and active.
				</SettingsNotice>
			)}
		</>
	);
}

function IdentityLine({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<span className="shrink-0 text-mini uppercase tracking-wide text-muted-foreground/70">
				{label}
			</span>
			<span
				className={
					mono
						? "min-w-0 truncate font-mono text-mini text-foreground"
						: "min-w-0 truncate text-mini text-foreground"
				}
				title={value}
			>
				{value}
			</span>
		</div>
	);
}

/** Human-readable access-token expiry. Expired/bricked is phrased as a
 *  needs-action state (Phase-5 reconnect framing), not a hard error. */
function describeExpiry(status: CloudCodexIdentityStatus): string {
	if (status.bricked) return "Expired — needs re-authorization";
	if (status.accessExp == null) return "—";
	const expMs = status.accessExp * 1000;
	if (isCloudIdentityExpired(status)) return "Expired — needs re-authorization";
	const deltaMs = expMs - Date.now();
	return `Valid for ${formatDuration(deltaMs)} (${new Date(expMs).toLocaleString()})`;
}

function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60_000));
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h`;
	return `${totalMinutes}m`;
}
