import {
	ArrowLeft,
	ArrowRight,
	Layers,
	PackageCheck,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	getCliStatus,
	getHelmorSkillsStatus,
	installCli,
	installHelmorSkills,
} from "@/lib/api";
import { SetupItem } from "../components/setup-item";
import type { OnboardingStep } from "../types";

const SETUP_FAILED_MESSAGE =
	"Something went wrong — don't worry, Helmor will work fine without it.";

/**
 * The CLI binary name to show in the "Power up Helmor" mockup
 * terminal. Mirrors the Rust-side `installed_cli_name()` decision:
 * release builds install the canonical `helmor`, dev builds install
 * `helmor-dev` (so they don't shadow a release install on the same
 * machine). Driven by `import.meta.env.DEV` rather than an IPC call
 * because (a) it's known at build time, (b) we don't want a flash of
 * the wrong name while a status query resolves, (c) this is purely
 * cosmetic — actual CLI invocation is handled by the install flow.
 */
const ONBOARDING_CLI_NAME = import.meta.env.DEV ? "helmor-dev" : "helmor";

/**
 * Onboarding "Power up Helmor" step.
 *
 * Behaviour contract:
 * - On entry the step kicks off Helmor CLI + Helmor Skills install in
 *   the background. The user sees a spinner per item that flips to a
 *   ready check when each finishes.
 * - The user never has to click "Set up" — that primary path is the
 *   silent auto-install. The button only re-appears (labelled "Retry")
 *   when an install fails, so the user can recover without leaving the
 *   step.
 * - If the user advances past this step before installs finish, the
 *   in-flight Tauri invocations keep running on the Rust side; only the
 *   local component setState calls get short-circuited via `cancelled`.
 *   That matches the user's request: "if they skip quickly we still
 *   install for them in the background".
 */
export function SkillsStep({
	step,
	onBack,
	onNext,
	isRoutingImport,
}: {
	step: OnboardingStep;
	onBack: () => void;
	onNext: () => void;
	isRoutingImport: boolean;
}) {
	const [isInstallingCli, setIsInstallingCli] = useState(true);
	const [cliInstalled, setCliInstalled] = useState(false);
	const [cliInstallFailed, setCliInstallFailed] = useState(false);
	const [isInstallingSkills, setIsInstallingSkills] = useState(true);
	const [skillsInstalled, setSkillsInstalled] = useState(false);
	const [skillsInstallFailed, setSkillsInstallFailed] = useState(false);

	const runInstallCli = useCallback(async () => {
		setIsInstallingCli(true);
		setCliInstallFailed(false);
		try {
			const status = await installCli();
			setCliInstalled(status.installState === "managed");
		} catch {
			setCliInstallFailed(true);
		} finally {
			setIsInstallingCli(false);
		}
	}, []);

	const runInstallSkills = useCallback(async () => {
		setIsInstallingSkills(true);
		setSkillsInstallFailed(false);
		try {
			const status = await installHelmorSkills();
			setSkillsInstalled(status.installed);
		} catch {
			setSkillsInstallFailed(true);
		} finally {
			setIsInstallingSkills(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			// Probe current state first so we don't redo work for users
			// re-entering onboarding with everything already installed.
			const [cliStatus, skillsStatus] = await Promise.all([
				getCliStatus().catch(() => null),
				getHelmorSkillsStatus().catch(() => null),
			]);
			if (cancelled) return;

			const cliReady = cliStatus?.installState === "managed";
			const skillsReady = !!skillsStatus?.installed;
			setCliInstalled(cliReady);
			setSkillsInstalled(skillsReady);

			// Drop the spinner if there's nothing left to do.
			if (cliReady) setIsInstallingCli(false);
			if (skillsReady) setIsInstallingSkills(false);

			// Fire-and-forget installs for whatever isn't ready. We
			// deliberately don't await — the user may navigate away
			// (onNext) before either finishes, and that's fine.
			if (!cliReady) void runInstallCli();
			if (!skillsReady) void runInstallSkills();
		})();
		return () => {
			cancelled = true;
		};
	}, [runInstallCli, runInstallSkills]);

	return (
		<section
			aria-label="MCP and skills setup"
			aria-hidden={step !== "skills"}
			className={`absolute left-[calc(30vw-260px)] top-20 z-30 w-[520px] transition-all duration-1000 ease-[cubic-bezier(.22,.82,.2,1)] ${
				step === "skills"
					? "translate-x-0 translate-y-0 opacity-100"
					: step === "repoImport"
						? "pointer-events-none translate-x-0 translate-y-0 opacity-0"
						: step === "conductorTransition" || step === "completeTransition"
							? "pointer-events-none scale-[1.08] opacity-0 blur-sm"
							: "pointer-events-none -translate-x-[118vw] translate-y-[55vh] opacity-100"
			}`}
		>
			<div className="flex flex-col items-center">
				<div className="group relative -mt-8 mb-12 h-[280px] w-[420px]">
					<div className="absolute left-10 top-0 h-32 w-[340px] rotate-[-5deg] rounded-lg border border-border/55 bg-card p-4 shadow-2xl shadow-black/20 transition-transform duration-500 ease-[cubic-bezier(.22,.82,.2,1)] group-hover:-translate-x-3 group-hover:-translate-y-6 group-hover:rotate-[-8deg]">
						<div className="flex items-center gap-2">
							<Terminal className="size-4 text-muted-foreground" />
							<div className="h-3 w-24 rounded-full bg-foreground/16" />
						</div>
						<div className="mt-5 grid gap-2">
							<div className="h-2 rounded-full bg-foreground/10" />
							<div className="h-2 w-4/5 rounded-full bg-foreground/10" />
							<div className="h-2 w-2/3 rounded-full bg-foreground/10" />
						</div>
					</div>
					<div className="absolute left-[30px] top-16 h-32 w-[360px] rotate-[3deg] rounded-lg border border-border/60 bg-card p-4 shadow-2xl shadow-black/25 transition-transform duration-500 ease-[cubic-bezier(.22,.82,.2,1)] group-hover:translate-x-4 group-hover:-translate-y-3 group-hover:rotate-[5deg]">
						<div className="flex items-center gap-2">
							<Layers className="size-4 text-muted-foreground" />
							<div className="h-3 w-28 rounded-full bg-foreground/18" />
						</div>
						<div className="mt-5 grid grid-cols-3 gap-2">
							<div className="h-14 rounded-md bg-foreground/8" />
							<div className="h-14 rounded-md bg-foreground/12" />
							<div className="h-14 rounded-md bg-foreground/8" />
						</div>
					</div>
					<div className="absolute left-5 top-[104px] h-44 w-[380px] rotate-[-1deg] overflow-hidden rounded-lg border border-border/65 bg-card shadow-2xl shadow-black/30 transition-transform duration-500 ease-[cubic-bezier(.22,.82,.2,1)] group-hover:translate-y-3 group-hover:rotate-0">
						<div className="flex h-8 items-center gap-1.5 border-b border-border/55 bg-background px-3">
							<span className="size-2 rounded-full bg-muted-foreground/35" />
							<span className="size-2 rounded-full bg-muted-foreground/25" />
							<span className="size-2 rounded-full bg-muted-foreground/20" />
							<span className="ml-2 text-micro font-medium text-muted-foreground">
								{`${ONBOARDING_CLI_NAME} --help`}
							</span>
						</div>
						<div className="h-[calc(100%-2rem)] overflow-hidden px-4 py-3 font-mono text-nano leading-[13px] text-muted-foreground group-hover:overflow-y-auto">
							<pre className="whitespace-pre-wrap break-words font-mono">
								<span className="text-foreground">{`$ ${ONBOARDING_CLI_NAME} --help`}</span>
								{`
Remote-control Helmor from the terminal.
Works against the same SQLite database the desktop app uses.

Usage: ${ONBOARDING_CLI_NAME} [OPTIONS] <COMMAND>

Commands:
  data         Data directory, database, and mode info
  settings     App settings stored in settings table
  repo         Repository registration and configuration
  workspace    Workspace CRUD, branching, syncing, archiving
  session      Session CRUD and inspection
  files        File listing, reading, writing, staging
  send         Send a prompt to an AI agent
  models       List available AI models
  github       GitHub integration - auth, PR lookup, merge
  scripts      Inspect repo-level setup/run/archive scripts
  conductor    Migrate from Helmor v1 (Conductor)
  completions  Shell completion scripts
  cli-status   Report whether ${ONBOARDING_CLI_NAME} is installed to PATH
  quit         Ask a running Helmor app to quit
  mcp          Run as an MCP server over stdio
  help         Print this message

Options:
  --json            Emit JSON
  --quiet           Reduce output
  --data-dir <DIR>  Override the data directory
  -h, --help        Print help
  -V, --version     Print version`}
							</pre>
						</div>
					</div>
				</div>

				<div className="w-full text-center">
					<h2 className="text-3xl font-semibold tracking-normal text-foreground">
						Power up Helmor
					</h2>
					<p className="mx-auto mt-3 max-w-md text-body leading-6 text-muted-foreground">
						Helmor is installing the CLI and skills in the background so it can
						split work, run agents, call tools, and carry context across your
						workspaces.
					</p>
				</div>

				<div className="mt-7 grid w-full gap-3">
					<SetupItem
						icon={<Terminal className="size-5" />}
						label="Helmor CLI"
						description="Control Helmor from your terminal: create workspaces, send prompts, inspect files, and script repeatable flows."
						actionLabel={isInstallingCli ? "Installing" : "Retry"}
						onAction={runInstallCli}
						busy={isInstallingCli}
						ready={cliInstalled}
						error={cliInstallFailed ? SETUP_FAILED_MESSAGE : null}
					/>
					<SetupItem
						icon={<PackageCheck className="size-5" />}
						label="Helmor Skills (Beta)"
						description="Install skills so Helmor can help with more workflows across every workspace."
						actionLabel={isInstallingSkills ? "Installing" : "Retry"}
						onAction={runInstallSkills}
						busy={isInstallingSkills}
						ready={skillsInstalled}
						error={skillsInstallFailed ? SETUP_FAILED_MESSAGE : null}
					/>
				</div>

				<div className="mt-7 flex items-center justify-center gap-3">
					<Button
						type="button"
						variant="ghost"
						size="lg"
						onClick={onBack}
						className="h-11 gap-2 px-4 text-title"
					>
						<ArrowLeft data-icon="inline-start" className="size-4" />
						Back
					</Button>
					<Button
						type="button"
						size="lg"
						onClick={onNext}
						disabled={isRoutingImport}
						className="h-11 gap-2 px-4 text-title"
					>
						Next
						<ArrowRight data-icon="inline-end" className="size-4" />
					</Button>
				</div>
			</div>
		</section>
	);
}
