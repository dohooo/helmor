import { Bot, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloudClaudeIdentityStatus } from "@/lib/team-api";
import type { TeamConfig } from "@/lib/team-mode";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../../components/settings-row";
import { useCloudClaudeIdentity } from "./use-cloud-claude-identity";

/**
 * Settings → Team "Cloud Run Identity · Claude" panel.
 *
 * Cloud sessions run Claude under a dedicated subscription identity held
 * server-side (a per-member `ClaudeIdentity` Durable Object). This panel shows
 * whether that identity is set and offers a one-time `Authorize` flow that runs
 * `claude setup-token` locally and uploads only the long-lived OAuth token to
 * the control plane — the token never touches this UI.
 *
 * The Claude credential is self-contained, ~1-year, inference-only, so there is
 * no expiry / account / bricked state to render (unlike the Codex panel) — just
 * a present/absent status. Mirrors {@link CloudIdentityPanel}: this outer gate
 * calls NO hooks and returns `null` outside team mode, so the React Query read
 * never mounts in the local single-user path.
 */
export function CloudClaudeIdentityPanel() {
	const cfg = isTeamModeActive() ? getTeamConfig() : null;
	if (!cfg) return null;
	return <CloudClaudeIdentityPanelContent cfg={cfg} />;
}

function CloudClaudeIdentityPanelContent({ cfg }: { cfg: TeamConfig }) {
	const { status, isLoading, isError, isAuthorizing, authorize, refetch } =
		useCloudClaudeIdentity(cfg);

	return (
		<SettingsGroup>
			<SettingsRow
				align="start"
				title={
					<span className="flex items-center gap-1.5">
						<Bot className="size-4 text-muted-foreground" />
						Cloud Run Identity · Claude
					</span>
				}
				description={
					<CloudClaudeIdentityDescription
						status={status}
						isLoading={isLoading}
						isError={isError}
					/>
				}
			>
				<div className="flex items-center gap-1.5">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={refetch}
						disabled={isLoading || isAuthorizing}
						aria-label="Refresh cloud Claude identity status"
						className="cursor-pointer"
					>
						<RefreshCw
							className={isLoading ? "size-3.5 animate-spin" : "size-3.5"}
						/>
					</Button>
					<Button
						variant="outline"
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
						{authorizeLabel(status, isAuthorizing)}
					</Button>
				</div>
			</SettingsRow>
		</SettingsGroup>
	);
}

/** Button copy: first-time "Authorize Claude (cloud)", else "Re-authorize". */
function authorizeLabel(
	status: CloudClaudeIdentityStatus | undefined,
	isAuthorizing: boolean,
): string {
	if (isAuthorizing) return "Authorizing…";
	if (status?.hasToken) return "Re-authorize";
	return "Authorize Claude (cloud)";
}

function CloudClaudeIdentityDescription({
	status,
	isLoading,
	isError,
}: {
	status: CloudClaudeIdentityStatus | undefined;
	isLoading: boolean;
	isError: boolean;
}) {
	const intro =
		"Cloud sessions authenticate Claude with a subscription identity held in the team control plane — never stored on this machine or in the container. Authorize once to bind it.";

	if (isLoading) {
		return (
			<>
				<div>{intro}</div>
				<SettingsNotice tone="info" className="mt-2">
					<span className="flex items-center gap-1.5">
						<Loader2 className="size-3 animate-spin" />
						Checking cloud Claude identity…
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
					Couldn't reach the team control plane to read the cloud Claude
					identity.
				</SettingsNotice>
			</>
		);
	}

	if (!status?.hasToken) {
		return (
			<>
				<div>{intro}</div>
				<SettingsNotice tone="info" className="mt-2">
					No cloud Claude identity yet — authorize to enable Claude on cloud
					runs.
				</SettingsNotice>
			</>
		);
	}

	return (
		<>
			<div>{intro}</div>
			<SettingsNotice tone="ok" className="mt-2">
				Cloud Claude is authorized and active.
			</SettingsNotice>
			<SettingsNotice tone="info" className="mt-2">
				Heads up: from June 15, 2026, cloud (Agent SDK) usage on subscription
				plans draws from a separate per-user monthly Agent SDK credit you must
				claim once — cloud runs may fail with a billing error until you do.
			</SettingsNotice>
		</>
	);
}
