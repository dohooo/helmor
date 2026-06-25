import { CloudCog } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	getCloudClaudeIdentityStatus,
	getCloudCodexIdentityStatus,
} from "@/lib/team-api";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import { SettingsNotice, SettingsRow } from "../components/settings-row";

/**
 * Dev-only read-out of the live team backend + bound cloud identity.
 *
 * Surfaces the two facts that are otherwise invisible from the UI and cost a
 * lot of D1 spelunking to recover when a cloud run "does nothing":
 *   1. Which TOKEN KIND is saved — an admin/companion token can READ identity
 *      status but can't authorize Codex/Claude (the PUT routes are member-only
 *      → 401), whereas a member/invite token can.
 *   2. Whether a cloud identity is actually BOUND (Codex/Claude `hasToken`) and
 *      under which ChatGPT account.
 *
 * Pure reads (no mutation): the token kind is inferred locally from the saved
 * config; "Check identity" hits the control plane on demand (like the
 * containers list), never on mount.
 */

/** Companion/admin tokens are minted `hlm_<hex>` (see provision-team.ts);
 *  member/invite tokens are UUIDs (`crypto.randomUUID()`). */
function classifyToken(token: string): {
	label: string;
	tone: "info" | "warn";
} {
	if (!token) return { label: "none", tone: "warn" };
	if (token.startsWith("hlm_"))
		return { label: "Admin / companion token", tone: "warn" };
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(token))
		return { label: "Member / invite token", tone: "info" };
	return { label: "unknown", tone: "warn" };
}

interface IdentitySnapshot {
	codex: { hasToken: boolean; accountId: string | null } | null;
	claude: { hasToken: boolean } | null;
	error: string | null;
}

export function TeamCloudDiagnostics() {
	const cfg = getTeamConfig();
	const teamMode = isTeamModeActive();
	const [snapshot, setSnapshot] = useState<IdentitySnapshot | null>(null);
	const [checking, setChecking] = useState(false);

	const check = useCallback(async () => {
		if (!cfg) return;
		setChecking(true);
		setSnapshot(null);
		try {
			const [codex, claude] = await Promise.all([
				getCloudCodexIdentityStatus(cfg),
				getCloudClaudeIdentityStatus(cfg),
			]);
			setSnapshot({ codex, claude, error: null });
		} catch (e) {
			setSnapshot({
				codex: null,
				claude: null,
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setChecking(false);
		}
	}, [cfg]);

	const tokenKind = cfg ? classifyToken(cfg.token) : null;

	return (
		<SettingsRow
			align="start"
			title={
				<span className="flex items-center gap-1.5">
					<CloudCog
						className="size-3.5 text-muted-foreground"
						strokeWidth={1.8}
					/>
					<span>Backend & cloud identity</span>
				</span>
			}
			description={
				<>
					The live team backend this app talks to, and the bound cloud agent
					identity.
					{!cfg ? (
						<SettingsNotice tone="info">
							No team backend configured (local mode).
						</SettingsNotice>
					) : (
						<>
							<div className="mt-2 grid gap-1 text-mini">
								<DiagLine label="Worker" value={cfg.url} />
								<DiagLine
									label="Token"
									value={`${tokenKind?.label} · ${cfg.token.slice(0, 8)}…`}
								/>
								<DiagLine
									label="Team mode"
									value={teamMode ? "on" : "off (saved, not active)"}
								/>
							</div>
							{tokenKind?.tone === "warn" ? (
								<SettingsNotice tone="warn">
									An admin/companion token can read status but cannot authorize
									Codex/Claude — the identity PUT routes are member-only (→
									401). Join via an invite link to get a member token.
								</SettingsNotice>
							) : null}
							{snapshot?.error ? (
								<SettingsNotice tone="error">{snapshot.error}</SettingsNotice>
							) : null}
							{snapshot && !snapshot.error ? (
								<div className="mt-2 grid gap-1 text-mini">
									<DiagLine
										label="Codex"
										value={
											snapshot.codex?.hasToken
												? `bound${snapshot.codex.accountId ? ` · ${snapshot.codex.accountId}` : ""}`
												: "no identity bound"
										}
									/>
									<DiagLine
										label="Claude"
										value={
											snapshot.claude?.hasToken ? "bound" : "no identity bound"
										}
									/>
								</div>
							) : null}
						</>
					)}
				</>
			}
		>
			<Button
				variant="outline"
				size="sm"
				onClick={() => void check()}
				disabled={!cfg || checking}
			>
				{checking ? "Checking…" : "Check identity"}
			</Button>
		</SettingsRow>
	);
}

function DiagLine({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<span className="shrink-0 uppercase tracking-wide text-muted-foreground/70">
				{label}
			</span>
			<span
				className="min-w-0 truncate font-mono text-foreground"
				title={value}
			>
				{value}
			</span>
		</div>
	);
}
