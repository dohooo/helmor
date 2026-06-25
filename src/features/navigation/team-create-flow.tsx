import {
	AlertTriangle,
	ArrowLeft,
	Check,
	ExternalLink,
	KeyRound,
	Loader2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCloudClaudeIdentity } from "@/features/settings/panels/cloud-identity/use-cloud-claude-identity";
import { useCloudIdentity } from "@/features/settings/panels/cloud-identity/use-cloud-identity";
import { useTeamIdentity } from "@/features/team/use-team-identity";
import {
	deployTeamCloud,
	type TeamDeployProgress,
	type TeamDeployStep,
} from "@/lib/api";
import { openUrl } from "@/lib/platform-bridge";
import { acceptInvite, createTeam, mintInvite } from "@/lib/team-api";
import type { TeamConfig } from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";
import { describeUnknownError } from "@/lib/workspace-helpers";
import { publishShellEvent } from "@/shell/event-bus";

/**
 * "Create a team" path of the setup card: stand up a fresh Cloudflare backend
 * for the admin in-app. Drives {@link deployTeamCloud} (Cloudflare OAuth →
 * provision → deploy), shows live per-step progress, then an `authorize` step
 * to bind the cloud agent identities (Codex / Claude) — without one, cloud runs
 * have no subscription identity and produce no result. Finishing persists the
 * config + switches into team mode (the connecting overlay covers the cold
 * start).
 *
 * Non-error branches the UI handles: `needs-upgrade` (the account lacks Workers
 * Paid — deep-link + retry) and a graceful error fallback to Advanced setup.
 */
type Phase = "intro" | "running" | "needs-upgrade" | "authorize" | "error";
type StepStatus = "pending" | "active" | "done" | "error";

const STEPS: { key: TeamDeployStep; label: string }[] = [
	{ key: "login", label: "Connect Cloudflare" },
	{ key: "plan", label: "Check account plan" },
	{ key: "provision", label: "Provision backend (D1 / R2 / secrets)" },
	{ key: "deploy", label: "Deploy Worker + sandbox" },
	{ key: "verify", label: "Verify it's live" },
];

const ALL_PENDING: Record<TeamDeployStep, StepStatus> = {
	login: "pending",
	plan: "pending",
	provision: "pending",
	deploy: "pending",
	verify: "pending",
};

export function TeamCreateFlow({
	onBack,
	onDone,
}: {
	onBack: () => void;
	onDone: () => void;
}) {
	const [phase, setPhase] = useState<Phase>("intro");
	const [stepStatus, setStepStatus] =
		useState<Record<TeamDeployStep, StepStatus>>(ALL_PENDING);
	const [error, setError] = useState<string | null>(null);
	const [upgradeUrl, setUpgradeUrl] = useState<string | null>(null);
	// Set once the deploy succeeds; drives the cloud-identity authorize step and
	// the final switch. The cloud-identity hooks read it directly (the config
	// isn't persisted until Finish), so authorize works before we switch in.
	const [deployedConfig, setDeployedConfig] = useState<TeamConfig | null>(null);

	const codex = useCloudIdentity(deployedConfig);
	const claude = useCloudClaudeIdentity(deployedConfig);
	const { identity } = useTeamIdentity();

	const run = useCallback(async () => {
		setPhase("running");
		setError(null);
		setStepStatus(ALL_PENDING);
		try {
			const result = await deployTeamCloud({
				onProgress: (event: TeamDeployProgress) => {
					setStepStatus((current) => ({
						...current,
						[event.step]:
							event.status === "error"
								? "error"
								: event.status === "done"
									? "done"
									: "active",
					}));
				},
			});
			if (result.kind === "needs-upgrade") {
				setUpgradeUrl(result.upgradeUrl);
				setPhase("needs-upgrade");
				return;
			}
			const adminConfig = { url: result.workerUrl, token: result.adminToken };
			// Bootstrap the single team row (admin-gated by the companion token).
			await createTeam(adminConfig).catch(() => {});
			// The deploy hands back the shared companion token, which the worker
			// treats as "admin" (no member) — but cloud-identity is MEMBER-scoped,
			// so authorizing with it 401s. Register the creator as a member (mint an
			// invite + accept it as themselves) and use that member token, exactly
			// like the invite-join path, so cloud-identity authorize works.
			let config = adminConfig;
			if (identity) {
				try {
					const invite = await mintInvite(adminConfig);
					await acceptInvite(adminConfig.url, invite.token, identity);
					config = { url: result.workerUrl, token: invite.token };
				} catch {
					// Fall back to the admin token; cloud-identity authorize may 401,
					// which the user then sees on the authorize step.
				}
			}
			setDeployedConfig(config);
			// Don't switch in yet: first let the user bind a cloud agent identity,
			// otherwise cloud runs would have nothing to authenticate with.
			setPhase("authorize");
		} catch (caught) {
			setError(describeUnknownError(caught, "Cloud setup didn't finish."));
			setPhase("error");
		}
	}, [identity]);

	const finish = useCallback(() => {
		if (deployedConfig) {
			// Persists config, flips team mode on, repoints the transport in place —
			// same mechanism as the invite-join path.
			switchTeamMode(deployedConfig);
		}
		onDone();
	}, [deployedConfig, onDone]);

	const running = phase === "running";
	const codexAuthorized = codex.status?.hasToken ?? false;
	const claudeAuthorized = claude.status?.hasToken ?? false;

	return (
		<div>
			<div className="flex items-center gap-2">
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={onBack}
					disabled={running}
					aria-label="Back"
					className="text-muted-foreground"
				>
					<ArrowLeft className="size-4" />
				</Button>
				<h2 className="font-semibold text-lg">Create a team</h2>
			</div>
			<p className="mt-1 text-mini text-muted-foreground leading-tight">
				Helmor stands up your own Cloudflare backend — sign in once and we
				provision and deploy everything for you.
			</p>

			<ol className="mt-4 flex flex-col gap-2">
				{STEPS.map(({ key, label }) => {
					const status = stepStatus[key];
					return (
						<li key={key} className="flex items-center gap-2 text-ui">
							<StepIcon status={status} />
							<span
								className={
									status === "pending"
										? "text-muted-foreground"
										: status === "error"
											? "text-status-danger"
											: "text-foreground"
								}
							>
								{label}
							</span>
						</li>
					);
				})}
			</ol>

			{phase === "needs-upgrade" ? (
				<div className="mt-4 flex flex-col gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3">
					<p className="font-medium text-ui">Workers Paid required</p>
					<p className="text-mini text-muted-foreground leading-tight">
						Cloud sandboxes run on Cloudflare Containers, which need the Workers
						Paid plan ($5/mo). Upgrade your account, then retry.
					</p>
					<div className="flex items-center gap-2">
						<Button
							size="sm"
							onClick={() => upgradeUrl && void openUrl(upgradeUrl)}
						>
							<ExternalLink className="size-3.5" />
							Upgrade on Cloudflare
						</Button>
						<Button variant="outline" size="sm" onClick={() => void run()}>
							I've upgraded — retry
						</Button>
					</div>
				</div>
			) : null}

			{phase === "authorize" ? (
				<div className="mt-4 flex flex-col gap-2">
					<p className="text-mini text-muted-foreground leading-tight">
						Authorize the agents you'll run in the cloud. They sign in with your
						subscription, held in the team control plane — never on this machine
						or in the container.
					</p>
					<AgentAuthRow
						label="Codex (ChatGPT)"
						authorized={codexAuthorized}
						busy={codex.isAuthorizing}
						onAuthorize={codex.authorize}
					/>
					<AgentAuthRow
						label="Claude"
						authorized={claudeAuthorized}
						busy={claude.isAuthorizing}
						onAuthorize={claude.authorize}
					/>
					{!codexAuthorized && !claudeAuthorized ? (
						<p className="text-mini text-status-warning leading-tight">
							Authorize at least one — cloud runs need an agent identity to
							return results.
						</p>
					) : null}
					<div className="mt-1 flex justify-end">
						<Button size="sm" onClick={finish}>
							Finish
						</Button>
					</div>
				</div>
			) : null}

			{phase === "error" ? (
				<div className="mt-4 flex flex-col gap-2">
					<p className="text-mini text-status-danger leading-tight">{error}</p>
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={() => void run()}>
							Try again
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								onDone();
								publishShellEvent({ type: "open-settings", section: "team" });
							}}
						>
							Advanced setup
						</Button>
					</div>
				</div>
			) : null}

			{phase === "intro" ? (
				<div className="mt-5 flex justify-end">
					<Button onClick={() => void run()}>
						Connect Cloudflare & deploy
					</Button>
				</div>
			) : null}

			{running ? (
				<p className="mt-4 text-mini text-muted-foreground leading-tight">
					A browser window opens for Cloudflare sign-in. Keep this open —
					deploying a fresh backend takes a minute or two.
				</p>
			) : null}
		</div>
	);
}

function AgentAuthRow({
	label,
	authorized,
	busy,
	onAuthorize,
}: {
	label: string;
	authorized: boolean;
	busy: boolean;
	onAuthorize: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-2 rounded-lg border border-border/45 bg-card/60 px-3 py-2">
			<span className="flex items-center gap-1.5 text-ui">
				{authorized ? (
					<Check className="size-4 text-status-success" strokeWidth={2.4} />
				) : (
					<KeyRound
						className="size-4 text-muted-foreground"
						strokeWidth={1.8}
					/>
				)}
				<span>{label}</span>
				{authorized ? (
					<span className="text-mini text-status-success">authorized</span>
				) : null}
			</span>
			<Button
				variant={authorized ? "outline" : "default"}
				size="sm"
				onClick={onAuthorize}
				disabled={busy}
			>
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
				{authorized ? "Re-authorize" : "Authorize"}
			</Button>
		</div>
	);
}

function StepIcon({ status }: { status: StepStatus }) {
	if (status === "done") {
		return <Check className="size-4 text-status-success" strokeWidth={2.4} />;
	}
	if (status === "active") {
		return <Loader2 className="size-4 animate-spin text-status-warning" />;
	}
	if (status === "error") {
		return <AlertTriangle className="size-4 text-status-danger" />;
	}
	return (
		<span
			className="size-4 rounded-full border border-border/60"
			aria-hidden="true"
		/>
	);
}
