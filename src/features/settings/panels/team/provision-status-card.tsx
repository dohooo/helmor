import { ExternalLink } from "lucide-react";
import { openUrl } from "@/lib/platform-bridge";
import type { TeamConfig } from "@/lib/team-mode";
import type { TeamReadinessState } from "@/lib/team-readiness";
import { useTeamReadiness } from "@/lib/team-readiness";
import { cn } from "@/lib/utils";

/**
 * Read-only provision status card — "your team cloud, managed for you".
 *
 * v1 (裁决①/②, 方案丙 pure-frontend): three rows only. The Worker row is LIVE
 * (it mirrors the existing readiness probe — zero new requests); the D1/R2
 * rows show the fixed names the provision script creates and follow the
 * Worker's health (if the Worker answers, provisioning happened). The
 * "Sandbox image" and "Last backup" rows return when 方案乙 lands (a
 * PASSIVE `GET /team/provision-status` Worker endpoint) — don't fake them.
 *
 * Cloudflare links use the dash's `?to=/:account/…` deep-link form, which
 * resolves the account after login — no account id needed locally.
 */

/** Fixed resource names — keep in sync with `cloud/scripts/provision-team.ts`
 *  (`d1 create helmor-team`, `r2 bucket create helmor-team-backups`). */
const D1_NAME = "helmor-team";
const R2_NAME = "helmor-team-backups";

const CF_DASH = "https://dash.cloudflare.com/?to=/:account";

export function ProvisionStatusCard({ cfg }: { cfg: TeamConfig }) {
	const readiness = useTeamReadiness();
	const host = hostFromUrl(cfg.url);

	return (
		<div className="overflow-hidden rounded-lg border border-border/60">
			<div className="px-4 py-3">
				<div className="text-ui font-medium">Your team cloud</div>
				<div className="mt-0.5 text-small text-muted-foreground">
					Provisioned on Cloudflare · everything managed for you
				</div>
			</div>
			<div className="divide-y divide-border/40 border-t border-border/40">
				<StatusRow
					state={readiness.state}
					name="Worker"
					detail={host}
					href={`${CF_DASH}/workers-and-pages`}
				/>
				<StatusRow
					state={readiness.state}
					name="Database"
					detail={`D1 · ${D1_NAME}`}
					href={`${CF_DASH}/workers/d1`}
				/>
				<StatusRow
					state={readiness.state}
					name="Storage"
					detail={`R2 · ${R2_NAME}`}
					href={`${CF_DASH}/r2/overview`}
				/>
			</div>
		</div>
	);
}

function StatusRow({
	state,
	name,
	detail,
	href,
}: {
	state: TeamReadinessState;
	name: string;
	detail: string;
	href: string;
}) {
	return (
		<div className="flex items-center gap-2.5 px-4 py-2.5 text-small">
			<StatusDot state={state} />
			<span className="w-[96px] shrink-0 text-foreground">{name}</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground">
				{detail}
			</span>
			<button
				type="button"
				onClick={() => void openUrl(href)}
				className="flex shrink-0 cursor-pointer items-center gap-1 text-mini text-muted-foreground hover:text-foreground"
				aria-label={`Open ${name} on Cloudflare`}
			>
				Cloudflare
				<ExternalLink className="size-3" strokeWidth={1.8} />
			</button>
		</div>
	);
}

function StatusDot({ state }: { state: TeamReadinessState }) {
	return (
		<span
			data-state={state}
			className={cn(
				"size-[7px] shrink-0 rounded-full",
				state === "ready" && "bg-status-success",
				state === "connecting" && "animate-pulse bg-status-warning",
				(state === "degraded" || state === "unconfigured") &&
					"bg-status-danger",
			)}
			aria-hidden="true"
		/>
	);
}

function hostFromUrl(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
