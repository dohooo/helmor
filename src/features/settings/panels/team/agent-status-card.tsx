import { AlertTriangle, Check, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useCloudClaudeIdentity } from "@/features/team/use-cloud-claude-identity";
import {
	isCloudIdentityExpired,
	useCloudIdentity,
} from "@/features/team/use-cloud-identity";
import type { CloudCodexIdentityStatus } from "@/lib/team-api";
import { getCodexIdentityEmail, type TeamConfig } from "@/lib/team-mode";
import { cn } from "@/lib/utils";

/**
 * Agent status card (R5-A) — the two "Cloud Run Identity" panels merged into
 * one collapsible card. Collapsed it's a single line ("Agent status ✓ …");
 * expanded it shows one row per agent with a human identity (the email
 * captured locally at authorize time — falls back to the account id for
 * pre-R5-A authorizations), the token lifetime, and Re-authorize.
 *
 * The card auto-expands while nothing is authorized (that state needs
 * action); once at least one agent is bound it collapses to its one-line
 * summary. A manual toggle always wins.
 */
export function AgentStatusCard({ cfg }: { cfg: TeamConfig }) {
	const codex = useCloudIdentity(cfg);
	const claude = useCloudClaudeIdentity(cfg);
	// null = user hasn't toggled; follow the derived default.
	const [manualOpen, setManualOpen] = useState<boolean | null>(null);

	const loading = codex.isLoading || claude.isLoading;
	const codexAuthorized = codex.status?.hasToken ?? false;
	const claudeAuthorized = claude.status?.hasToken ?? false;
	const anyAuthorized = codexAuthorized || claudeAuthorized;
	const needsAction = codex.needsReauthorize || (!loading && !anyAuthorized);
	const open = manualOpen ?? (!loading && !anyAuthorized);

	return (
		<div className="overflow-hidden rounded-lg border border-border/60">
			<button
				type="button"
				onClick={() => setManualOpen(!open)}
				aria-expanded={open}
				className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left"
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-90",
					)}
					strokeWidth={1.8}
				/>
				<span className="text-ui font-medium">Agent status</span>
				<SummaryGlyph loading={loading} needsAction={needsAction} />
				<span className="ml-auto min-w-0 truncate text-small text-muted-foreground">
					{summaryText({
						loading,
						isError: codex.isError && claude.isError,
						codexAuthorized,
						claudeAuthorized,
						codexNeedsReauthorize: codex.needsReauthorize,
					})}
				</span>
			</button>

			{open ? (
				<div className="divide-y divide-border/40 border-t border-border/40">
					<AgentRow
						name="Codex"
						identity={codexIdentityLine(codex.status)}
						lifetime={codexLifetime(codex.status)}
						authorized={codexAuthorized}
						busy={codex.isAuthorizing}
						error={codex.error}
						onAuthorize={codex.authorize}
					/>
					<AgentRow
						name="Claude"
						identity={
							claudeAuthorized ? "Authorized · long-lived" : "Not authorized"
						}
						lifetime={null}
						authorized={claudeAuthorized}
						busy={claude.isAuthorizing}
						error={claude.error}
						onAuthorize={claude.authorize}
					/>
				</div>
			) : null}
		</div>
	);
}

function SummaryGlyph({
	loading,
	needsAction,
}: {
	loading: boolean;
	needsAction: boolean;
}) {
	if (loading) {
		return (
			<Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
		);
	}
	if (needsAction) {
		return (
			<AlertTriangle
				className="size-3.5 shrink-0 text-status-warning"
				strokeWidth={2}
			/>
		);
	}
	return (
		<Check
			className="size-3.5 shrink-0 text-status-success"
			strokeWidth={2.4}
		/>
	);
}

function summaryText({
	loading,
	isError,
	codexAuthorized,
	claudeAuthorized,
	codexNeedsReauthorize,
}: {
	loading: boolean;
	isError: boolean;
	codexAuthorized: boolean;
	claudeAuthorized: boolean;
	codexNeedsReauthorize: boolean;
}): string {
	if (loading) return "Checking…";
	if (isError) return "Can't reach your team cloud";
	if (codexNeedsReauthorize) return "Codex expired — re-authorize";
	if (codexAuthorized && claudeAuthorized) return "Codex · Claude authorized";
	if (codexAuthorized) return "Codex authorized · Claude not set up";
	if (claudeAuthorized) return "Claude authorized · Codex not set up";
	return "Authorize agents to run in the cloud";
}

/** Human identity line for the Codex row: the locally-captured email first,
 *  the account id as the pre-R5-A fallback. */
function codexIdentityLine(
	status: CloudCodexIdentityStatus | undefined,
): string {
	if (!status?.hasToken) return "Not authorized";
	return getCodexIdentityEmail() ?? status.accountId ?? "Authorized";
}

/** Compact lifetime label ("Valid for 27d", "Expired — re-authorize"). */
function codexLifetime(
	status: CloudCodexIdentityStatus | undefined,
): string | null {
	if (!status?.hasToken) return null;
	if (status.bricked || isCloudIdentityExpired(status)) {
		return "Expired — re-authorize";
	}
	if (status.accessExp == null) return null;
	return `Valid for ${formatDuration(status.accessExp * 1000 - Date.now())}`;
}

function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60_000));
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h`;
	return `${totalMinutes}m`;
}

function AgentRow({
	name,
	identity,
	lifetime,
	authorized,
	busy,
	error,
	onAuthorize,
}: {
	name: string;
	identity: string;
	lifetime: string | null;
	authorized: boolean;
	busy: boolean;
	error: string | null;
	onAuthorize: () => void;
}) {
	return (
		<div className="flex flex-col gap-1 py-2.5 pr-4 pl-10">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="text-small font-medium text-foreground">{name}</div>
					<div className="truncate text-mini text-muted-foreground">
						{identity}
					</div>
				</div>
				{lifetime ? (
					<span className="shrink-0 text-mini text-muted-foreground">
						{lifetime}
					</span>
				) : null}
				<Button
					variant={authorized ? "outline" : "default"}
					size="sm"
					onClick={onAuthorize}
					disabled={busy}
					className="shrink-0 cursor-pointer"
				>
					{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
					{busy ? "Authorizing…" : authorized ? "Re-authorize" : "Authorize"}
				</Button>
			</div>
			{error ? (
				<p className="text-mini text-status-danger leading-tight">{error}</p>
			) : null}
		</div>
	);
}
