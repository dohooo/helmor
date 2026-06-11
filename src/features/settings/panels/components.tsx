import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	getHelmorComponentsUpdateCheck,
	type HelmorComponentsUpdateCheck,
	installCli,
	installHelmorSkills,
	recheckHelmorComponents,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsRow } from "../components/settings-row";

/**
 * Settings → General "Helmor components" row.
 *
 * Surfaces the per-version silent startup re-check of the Helmor CLI
 * symlink and the Helmor Skills package. Steady state: green check on
 * each, no controls. When the silent pass deferred work to the user
 * (CLI needs sudo, skills install errored), the affected row shows a
 * red mark + per-component Retry button. A "Re-check now" button
 * always clears the per-version cache and re-runs both halves.
 *
 * The actual install logic lives in the Rust system_commands module —
 * this panel is purely a presentation layer over the IPC snapshot.
 */
export function ComponentsPanel() {
	const [snapshot, setSnapshot] = useState<HelmorComponentsUpdateCheck | null>(
		null,
	);
	const [rechecking, setRechecking] = useState(false);
	const [retryingCli, setRetryingCli] = useState(false);
	const [retryingSkills, setRetryingSkills] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const next = await getHelmorComponentsUpdateCheck();
			setSnapshot(next);
		} catch (error) {
			// Reading the snapshot is a pure DB read; a failure here means
			// something is genuinely wrong with the install. Surface it
			// instead of swallowing.
			toast.error("Unable to read Helmor components status", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleRecheck = useCallback(async () => {
		setRechecking(true);
		try {
			const next = await recheckHelmorComponents();
			setSnapshot(next);
			if (!next.cliError && !next.skillsError) {
				toast.success("Helmor components are up to date");
			}
		} catch (error) {
			toast.error("Re-check failed", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setRechecking(false);
		}
	}, []);

	const handleRetryCli = useCallback(async () => {
		setRetryingCli(true);
		try {
			await installCli();
			await refresh();
		} catch (error) {
			toast.error("CLI install failed", {
				description: error instanceof Error ? error.message : String(error),
			});
			// Refresh anyway so any partial state is reflected.
			await refresh();
		} finally {
			setRetryingCli(false);
		}
	}, [refresh]);

	const handleRetrySkills = useCallback(async () => {
		setRetryingSkills(true);
		try {
			await installHelmorSkills();
			await refresh();
		} catch (error) {
			toast.error("Skills install failed", {
				description: error instanceof Error ? error.message : String(error),
			});
			await refresh();
		} finally {
			setRetryingSkills(false);
		}
	}, [refresh]);

	const cliOk = snapshot?.cli.installState === "managed" && !snapshot.cliError;
	const skillsOk = !!snapshot?.skills.installed && !snapshot?.skillsError;
	const cliBusy = rechecking || retryingCli;
	const skillsBusy = rechecking || retryingSkills;

	const summary = (() => {
		if (!snapshot) return "Loading components status…";
		if (cliOk && skillsOk) {
			const checked = snapshot.lastCheckedVersion;
			if (checked === snapshot.currentVersion) {
				return `Helmor CLI and skills are up to date with ${snapshot.currentVersion}.`;
			}
			return "Helmor CLI and skills look healthy.";
		}
		return "One or more components need attention.";
	})();

	return (
		<SettingsRow
			align="start"
			title="Helmor Components"
			description={
				<>
					<div>{summary}</div>
					{snapshot ? (
						<div className="mt-3 grid gap-2">
							<ComponentLine
								label="Helmor CLI"
								ok={cliOk}
								busy={cliBusy}
								onRetry={handleRetryCli}
								error={snapshot.cliError}
								state={describeCliState(snapshot)}
							/>
							<ComponentLine
								label="Helmor Skills"
								ok={skillsOk}
								busy={skillsBusy}
								onRetry={handleRetrySkills}
								error={snapshot.skillsError}
								state={describeSkillsState(snapshot)}
							/>
						</div>
					) : null}
				</>
			}
		>
			<Button
				variant="outline"
				size="sm"
				onClick={handleRecheck}
				disabled={rechecking || retryingCli || retryingSkills}
			>
				{rechecking ? (
					<Loader2 className="size-3.5 animate-spin" />
				) : (
					<RefreshCw className="size-3.5" />
				)}
				{rechecking ? "Checking" : "Re-check now"}
			</Button>
		</SettingsRow>
	);
}

function ComponentLine({
	label,
	ok,
	busy,
	error,
	state,
	onRetry,
}: {
	label: string;
	ok: boolean;
	busy: boolean;
	error: string | null;
	state: string;
	onRetry: () => void;
}) {
	const Icon = busy ? Loader2 : ok ? CheckCircle2 : XCircle;
	const iconClass = busy
		? "text-muted-foreground animate-spin"
		: ok
			? "text-green-500"
			: "text-destructive";
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="flex min-w-0 items-start gap-2">
				<Icon className={cn("mt-0.5 size-3.5 shrink-0", iconClass)} />
				<div className="min-w-0">
					<div className="text-small font-medium text-foreground">{label}</div>
					<div className="text-mini leading-snug text-muted-foreground">
						{error ?? state}
					</div>
				</div>
			</div>
			{!ok && !busy ? (
				<Button
					variant="ghost"
					size="sm"
					onClick={onRetry}
					className="h-7 shrink-0 px-2 text-mini"
				>
					Retry
				</Button>
			) : null}
		</div>
	);
}

function describeCliState(snapshot: HelmorComponentsUpdateCheck): string {
	switch (snapshot.cli.installState) {
		case "managed":
			return snapshot.cli.installPath
				? `Installed at ${snapshot.cli.installPath}.`
				: "Installed.";
		case "stale":
			return "An older copy exists at the install path.";
		case "missing":
			return "Not installed on this machine.";
		default:
			return "Status unavailable.";
	}
}

function describeSkillsState(snapshot: HelmorComponentsUpdateCheck): string {
	if (snapshot.skills.installed) {
		const parts: string[] = [];
		if (snapshot.skills.claude) parts.push("Claude Code");
		if (snapshot.skills.codex) parts.push("Codex");
		return parts.length > 0
			? `Installed for ${parts.join(" and ")}.`
			: "Installed.";
	}
	return "Sign in to Claude Code or Codex, then re-check.";
}
