import { Download, Loader2, PackageCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	getHelmorSkillsStatus,
	type HelmorSkillsStatus,
	installHelmorSkills,
} from "@/lib/api";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../components/settings-row";

/**
 * Settings panel mirror of the onboarding silent-install step for
 * Helmor skills. Onboarding takes care of the first-launch install;
 * this panel is the recovery / re-install surface for users whose
 * skills got out of date or whose initial install failed (e.g. no
 * network at onboarding time).
 *
 * Shape and tone deliberately mirror `CliInstallPanel` directly above
 * it so the two read as one feature.
 */
export function HelmorSkillsPanel() {
	const [status, setStatus] = useState<HelmorSkillsStatus | null>(null);
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void getHelmorSkillsStatus().then(setStatus).catch(setError);
	}, []);

	const handleInstall = useCallback(async () => {
		setInstalling(true);
		setError(null);
		try {
			const result = await installHelmorSkills();
			setStatus(result);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setInstalling(false);
		}
	}, []);

	const installed = !!status?.installed;
	const buttonLabel = installed ? "Reinstall" : "Install skills";

	return (
		<SettingsGroup>
			<SettingsRow
				align="start"
				title={
					<span className="flex items-center gap-1.5">
						<PackageCheck
							className="size-3.5 text-muted-foreground"
							strokeWidth={1.8}
						/>
						<span>Helmor Skills (Beta)</span>
					</span>
				}
				description={
					<>
						Bundled skills that teach Claude Code and Codex how to drive Helmor
						— create workspaces, dispatch ship actions, read other agents&apos;
						transcripts, and more. Onboarding installs these automatically;
						reinstall here if they got out of date or if first-launch install
						failed.
						{installed ? (
							<SettingsNotice tone="ok">
								Installed for {status?.claude ? <code>claude-code</code> : null}
								{status?.claude && status?.codex ? " + " : null}
								{status?.codex ? <code>codex</code> : null}
								{!status?.claude && !status?.codex
									? "the agents on this system"
									: "."}
							</SettingsNotice>
						) : (
							<SettingsNotice tone="warn">
								Not installed yet. Click reinstall to run the bundled install
								command (no network required beyond the npm registry probe).
							</SettingsNotice>
						)}
						{error ? (
							<SettingsNotice tone="error">{error}</SettingsNotice>
						) : null}
					</>
				}
			>
				<Button
					variant="outline"
					size="sm"
					onClick={handleInstall}
					disabled={installing}
				>
					{installing ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<Download className="size-3.5" strokeWidth={1.8} />
					)}
					{buttonLabel}
				</Button>
			</SettingsRow>
		</SettingsGroup>
	);
}
