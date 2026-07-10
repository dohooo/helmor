import {
	AlertTriangle,
	ArrowLeft,
	Check,
	Copy,
	ExternalLink,
	KeyRound,
	Loader2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCloudClaudeIdentity } from "@/features/team/use-cloud-claude-identity";
import { useCloudIdentity } from "@/features/team/use-cloud-identity";
import { useTeamIdentity } from "@/features/team/use-team-identity";
import {
	deployTeamCloud,
	type TeamDeployProgress,
	type TeamDeployStep,
} from "@/lib/api";
import { openUrl } from "@/lib/platform-bridge";
import { acceptInvite, createTeam, mintInvite } from "@/lib/team-api";
import { saveTeamAdminToken, type TeamConfig } from "@/lib/team-mode";
import { switchTeamMode } from "@/lib/team-switch";
import { describeUnknownError } from "@/lib/workspace-helpers";

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

// R5-A 裁决③: 方案 B copy — "we do it for you" voice, plain words over
// infrastructure nouns.
const STEPS: { key: TeamDeployStep; label: string }[] = [
	{ key: "login", label: "Connect Cloudflare" },
	{ key: "plan", label: "Check your plan" },
	{ key: "provision", label: "Provision storage" },
	{ key: "deploy", label: "Deploy your backend" },
	{ key: "verify", label: "Make sure it's live" },
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
	// The companion-token config the deploy hands back. Kept so the Retry
	// button can re-attempt member registration against it.
	const [adminConfig, setAdminConfig] = useState<TeamConfig | null>(null);
	// Set once the deploy succeeds; drives the cloud-identity authorize step and
	// the final switch. The cloud-identity hooks read it directly (the config
	// isn't persisted until Finish), so authorize works before we switch in.
	const [deployedConfig, setDeployedConfig] = useState<TeamConfig | null>(null);
	// The creator's MEMBER token once registration succeeds (null = not yet a
	// member, so the cloud-identity PUT routes would 401).
	const [memberToken, setMemberToken] = useState<string | null>(null);
	// Why registration couldn't bind a member token (identity unresolved /
	// mint/accept failed). Drives the Retry banner on the authorize step.
	const [memberError, setMemberError] = useState<string | null>(null);

	const codex = useCloudIdentity(deployedConfig);
	const claude = useCloudClaudeIdentity(deployedConfig);
	const { identity, refetch: refetchIdentity } = useTeamIdentity();

	// Register the creator as a team member so cloud-identity authorize uses a
	// MEMBER-scoped bearer. The cloud-identity PUT routes are member-only (the
	// shared companion token classifies as admin/no-member → 401), so without a
	// member token the Authorize buttons fail silently. We resolve the GitHub
	// identity robustly (the cached roster can be transiently empty if `gh` was
	// slow — refetch forces a fresh read) and NEVER silently fall back to the
	// companion token: a failure surfaces as `memberError` + a Retry.
	const registerMember = useCallback(
		async (admin: TeamConfig) => {
			const id = identity ?? (await refetchIdentity());
			if (!id) {
				setMemberToken(null);
				setDeployedConfig(admin);
				setMemberError(
					"Couldn't read your GitHub identity — connect GitHub in Settings → Accounts, then Retry.",
				);
				return;
			}
			try {
				const invite = await mintInvite(admin);
				await acceptInvite(admin.url, invite.token, id);
				setMemberToken(invite.token);
				setDeployedConfig({ url: admin.url, token: invite.token });
				setMemberError(null);
			} catch (caught) {
				setMemberToken(null);
				setDeployedConfig(admin);
				setMemberError(
					describeUnknownError(
						caught,
						"Couldn't register you as a team member — Retry.",
					),
				);
			}
		},
		[identity, refetchIdentity],
	);

	const run = useCallback(async () => {
		setPhase("running");
		setError(null);
		setMemberError(null);
		setMemberToken(null);
		setStepStatus(ALL_PENDING);
		// Capture the specific failing stage (e.g. verify's "Container start: …")
		// so the error phase names WHICH step failed and why — not a generic line
		// (WP6: "verify 任一步失败 → UI 指出具体哪一步").
		let stageError: string | null = null;
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
					if (event.status === "error") {
						const label =
							STEPS.find((s) => s.key === event.step)?.label ?? event.step;
						stageError = `${label}: ${event.message}`;
					}
				},
			});
			if (result.kind === "needs-upgrade") {
				setUpgradeUrl(result.upgradeUrl);
				setPhase("needs-upgrade");
				return;
			}
			const admin = { url: result.workerUrl, token: result.adminToken };
			setAdminConfig(admin);
			// R5-A: persist the admin token on THIS (the creator's) machine — it
			// is what gates the sidebar Invite button and authenticates minting.
			// Members never get one (their bearer is the invite token).
			saveTeamAdminToken(result.adminToken);
			// Bootstrap the single team row (admin-gated by the companion token).
			await createTeam(admin).catch(() => {});
			// Register the creator as a member + adopt that member token.
			await registerMember(admin);
			// Don't switch in yet: first let the user bind a cloud agent identity,
			// otherwise cloud runs would have nothing to authenticate with.
			setPhase("authorize");
		} catch (caught) {
			setError(
				stageError ??
					describeUnknownError(caught, "Cloud setup didn't finish."),
			);
			setPhase("error");
		}
	}, [registerMember]);

	const finish = useCallback(() => {
		if (deployedConfig) {
			// Persists config, flips team mode on, repoints the transport in place —
			// same mechanism as the invite-join path.
			switchTeamMode(deployedConfig);
		}
		onDone();
	}, [deployedConfig, onDone]);

	const running = phase === "running";
	const registered = memberToken !== null;
	const codexAuthorized = codex.status?.hasToken ?? false;
	const claudeAuthorized = claude.status?.hasToken ?? false;
	// Finish gate (WP6): a team with NO authorized agent identity can't run a
	// single @agent turn, so finishing into it lands the user in the exact broken
	// state this sprint is closing. Require a registered member + at least one
	// authorized agent; otherwise Finish stays disabled with an explicit reason.
	const canFinish = registered && (codexAuthorized || claudeAuthorized);

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
				Sign in to Cloudflare once — we provision, deploy, and verify everything
				for you.
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
						Choose which agents run in your cloud. They sign in with your
						subscription, kept safely in your team's control plane — never on
						this machine or in the container.
					</p>
					{!registered ? (
						<div className="flex flex-col items-start gap-1.5 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3">
							<p className="text-mini text-status-warning leading-tight">
								{memberError ??
									"Registering you as a team member so you can authorize agents…"}
							</p>
							{memberError && adminConfig ? (
								<Button
									variant="outline"
									size="sm"
									onClick={() => void registerMember(adminConfig)}
								>
									Retry
								</Button>
							) : null}
						</div>
					) : null}
					<AgentAuthRow
						label="Codex (ChatGPT)"
						authorized={codexAuthorized}
						busy={codex.isAuthorizing}
						error={codex.error}
						disabled={!registered}
						onAuthorize={codex.authorize}
					/>
					<AgentAuthRow
						label="Claude"
						authorized={claudeAuthorized}
						busy={claude.isAuthorizing}
						error={claude.error}
						disabled={!registered}
						onAuthorize={claude.authorize}
					/>
					{registered && !codexAuthorized && !claudeAuthorized ? (
						<p className="text-mini text-status-warning leading-tight">
							Authorize at least one — cloud runs need an agent identity to
							return results.
						</p>
					) : null}
					<div className="mt-1 flex justify-end">
						<Button size="sm" onClick={finish} disabled={!canFinish}>
							Finish
						</Button>
					</div>
				</div>
			) : null}

			{phase === "error" ? (
				<div className="mt-4 flex flex-col gap-2">
					<p className="text-mini text-status-danger leading-tight">{error}</p>
					{/* R5-A: no more "Advanced setup" fallback — manual Worker URL /
					    token entry left the product. Retry is the recovery path;
					    "Copy details" feeds a bug report (sidebar feedback button)
					    when retrying can't help. */}
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={() => void run()}>
							Try again
						</Button>
						<CopyErrorButton error={error} />
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
					A browser window opens for Cloudflare sign-in. Deploying takes a
					minute or two — we'll keep you posted right here.
				</p>
			) : null}
		</div>
	);
}

function CopyErrorButton({ error }: { error: string | null }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(() => {
		if (!error || !navigator.clipboard?.writeText) {
			return;
		}
		void navigator.clipboard.writeText(error).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [error]);
	return (
		<Button variant="outline" size="sm" onClick={handleCopy}>
			{copied ? (
				<Check className="size-3.5" strokeWidth={2.4} />
			) : (
				<Copy className="size-3.5" strokeWidth={1.8} />
			)}
			{copied ? "Copied" : "Copy details"}
		</Button>
	);
}

function AgentAuthRow({
	label,
	authorized,
	busy,
	error,
	disabled,
	onAuthorize,
}: {
	label: string;
	authorized: boolean;
	busy: boolean;
	error?: string | null;
	disabled?: boolean;
	onAuthorize: () => void;
}) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-border/45 bg-card/60 px-3 py-2">
			<div className="flex items-center justify-between gap-2">
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
					disabled={busy || disabled}
				>
					{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
					{authorized ? "Re-authorize" : "Authorize"}
				</Button>
			</div>
			{error ? (
				<p className="text-mini text-status-danger leading-tight">{error}</p>
			) : null}
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
