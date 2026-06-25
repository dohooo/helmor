import {
	AlertTriangle,
	ArrowLeft,
	Check,
	ExternalLink,
	Loader2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	deployTeamCloud,
	type TeamDeployProgress,
	type TeamDeployStep,
} from "@/lib/api";
import { openUrl } from "@/lib/platform-bridge";
import { createTeam } from "@/lib/team-api";
import { switchTeamMode } from "@/lib/team-switch";
import { describeUnknownError } from "@/lib/workspace-helpers";
import { publishShellEvent } from "@/shell/event-bus";

/**
 * "Create a team" path of the setup card: stand up a fresh Cloudflare backend
 * for the admin in-app. Drives {@link deployTeamCloud} (Cloudflare OAuth →
 * provision → deploy), shows live per-step progress, then persists the config +
 * switches into team mode — the connecting overlay takes over while the cold
 * sandbox wakes.
 *
 * Two non-error branches the UI must handle: `needs-upgrade` (the account lacks
 * Workers Paid, which Containers require — show a deep-link + retry) and a
 * graceful error fallback to the manual Advanced setup. The auto-deploy backend
 * itself requires our published public image + a paid Cloudflare account to run
 * end-to-end; until then the error branch keeps Create from being a dead end.
 */
type Phase = "intro" | "running" | "needs-upgrade" | "error" | "done";
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
			const config = { url: result.workerUrl, token: result.adminToken };
			// Bootstrap the single team row (idempotent; the admin token authorizes
			// it). Best-effort — switching in is what actually connects the user.
			await createTeam(config).catch(() => {});
			setPhase("done");
			// Persists config, flips team mode on, and repoints the transport in
			// place — same mechanism as the invite-join path.
			switchTeamMode(config);
			onDone();
		} catch (caught) {
			setError(describeUnknownError(caught, "Cloud setup didn't finish."));
			setPhase("error");
		}
	}, [onDone]);

	const running = phase === "running";

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
