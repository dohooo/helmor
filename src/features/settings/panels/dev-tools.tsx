import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { devResetAllData, loadDataInfo } from "@/lib/api";
import { saveSettings } from "@/lib/settings";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../components/settings-row";

export function DevToolsPanel() {
	const [dataDir, setDataDir] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [onboardingReset, setOnboardingReset] = useState(false);

	useEffect(() => {
		void loadDataInfo().then((info) => {
			if (info) setDataDir(info.dataRoot);
		});
	}, []);

	const handleReset = useCallback(async () => {
		setResetting(true);
		setError(null);
		try {
			await devResetAllData();
			// Full page reload to reset all component state (selected
			// workspace/session, settings context, etc.) — query invalidation
			// alone leaves stale useState references.
			window.location.reload();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setResetting(false);
			setConfirmOpen(false);
		}
	}, []);

	const handleResetOnboarding = useCallback(() => {
		void saveSettings({ onboardingCompleted: false });
		setOnboardingReset(true);
	}, []);

	return (
		<>
			<SettingsGroup>
				<SettingsRow
					align="start"
					title={
						<span className="flex items-center gap-1.5">
							<RotateCcw
								className="size-3.5 text-muted-foreground"
								strokeWidth={1.8}
							/>
							<span>Show Onboarding Again</span>
						</span>
					}
					description={
						<>
							Mark onboarding as incomplete so it appears the next time Helmor
							starts.
							{onboardingReset ? (
								<SettingsNotice tone="ok">
									Onboarding will be shown on the next launch.
								</SettingsNotice>
							) : null}
						</>
					}
				>
					<Button variant="outline" size="sm" onClick={handleResetOnboarding}>
						Reset Onboarding
					</Button>
				</SettingsRow>

				<SettingsRow
					align="start"
					title={
						<span className="flex items-center gap-1.5">
							<Trash2 className="size-3.5 text-destructive" strokeWidth={1.8} />
							<span>Reset All Data</span>
						</span>
					}
					description={
						<>
							Delete all workspaces, sessions, messages, and repositories from
							the development database. Filesystem artefacts (worktrees,
							paste-cache) will also be removed.
							{dataDir ? (
								<SettingsNotice tone="info">
									Data directory:{" "}
									<code className="rounded bg-muted px-1 py-0.5">
										{dataDir}
									</code>
								</SettingsNotice>
							) : null}
							{error ? (
								<SettingsNotice tone="error">{error}</SettingsNotice>
							) : null}
						</>
					}
				>
					<Button
						variant="destructive"
						size="sm"
						onClick={() => {
							setError(null);
							setConfirmOpen(true);
						}}
						disabled={resetting}
					>
						{resetting ? (
							<>
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
								Resetting...
							</>
						) : (
							"Reset All Dev Data"
						)}
					</Button>
				</SettingsRow>
			</SettingsGroup>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Confirm Reset"
				description={
					<>
						This will permanently delete{" "}
						<strong>all workspaces, sessions, and repositories</strong> from the
						development database. This action cannot be undone. You can
						re-import from Conductor afterwards.
					</>
				}
				confirmLabel={resetting ? "Resetting..." : "Delete Everything"}
				onConfirm={() => void handleReset()}
				loading={resetting}
			/>
		</>
	);
}
