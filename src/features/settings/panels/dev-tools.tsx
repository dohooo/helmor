import {
	Cloud,
	Container,
	FolderOpen,
	Loader2,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
	deleteTeamContainer,
	devResetAllData,
	listTeamContainers,
	loadDataInfo,
	revealPathInFinder,
	type TeamContainer,
} from "@/lib/api";
import { I18nText } from "@/lib/i18n";
import { saveSettings } from "@/lib/settings";
import { clearTeamConfig } from "@/lib/team-mode";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../components/settings-row";
import { TeamCloudDiagnostics } from "./team-cloud-diagnostics";

export function DevToolsPanel() {
	const [dataDir, setDataDir] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [onboardingReset, setOnboardingReset] = useState(false);
	const [containers, setContainers] = useState<TeamContainer[] | null>(null);
	const [loadingContainers, setLoadingContainers] = useState(false);
	const [containerError, setContainerError] = useState<string | null>(null);

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

	const handleResetTeamCloud = useCallback(() => {
		// Wipe the saved team backend, then reload so the live IPC transport
		// repoints back to local and the next "Team" pick starts at setup.
		clearTeamConfig();
		window.location.reload();
	}, []);

	const loadContainers = useCallback(async () => {
		setLoadingContainers(true);
		setContainerError(null);
		try {
			setContainers(await listTeamContainers());
		} catch (e) {
			setContainerError(e instanceof Error ? e.message : String(e));
			setContainers([]);
		} finally {
			setLoadingContainers(false);
		}
	}, []);

	const removeContainer = useCallback(
		async (id: string) => {
			setContainerError(null);
			try {
				await deleteTeamContainer(id);
				await loadContainers();
			} catch (e) {
				setContainerError(e instanceof Error ? e.message : String(e));
			}
		},
		[loadContainers],
	);

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
							<span>
								<I18nText source="showOnboardingAgain" />
							</span>
						</span>
					}
					description={
						<>
							<I18nText source="markOnboardingIncompleteSoAppearsNext" />
							{onboardingReset ? (
								<SettingsNotice tone="ok">
									<I18nText source="onboardingWillShownNextLaunch" />
								</SettingsNotice>
							) : null}
						</>
					}
				>
					<Button variant="outline" size="sm" onClick={handleResetOnboarding}>
						<I18nText source="resetOnboarding" />
					</Button>
				</SettingsRow>

				<SettingsRow
					align="start"
					title={
						<span className="flex items-center gap-1.5">
							<Trash2 className="size-3.5 text-destructive" strokeWidth={1.8} />
							<span>
								<I18nText source="resetAllData" />
							</span>
						</span>
					}
					description={
						<>
							<I18nText source="deleteAllWorkspacesSessionsMessagesRepositories" />
							{dataDir ? (
								<SettingsNotice tone="info">
									<I18nText source="dataDirectory" />{" "}
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
								<I18nText source="resetting" />
							</>
						) : (
							<I18nText source="resetAllDevData" />
						)}
					</Button>
				</SettingsRow>
			</SettingsGroup>

			<h3 className="mt-2 font-medium text-muted-foreground text-small">
				Diagnostics
			</h3>
			<SettingsGroup>
				<SettingsRow
					align="start"
					title={
						<span className="flex items-center gap-1.5">
							<FolderOpen
								className="size-3.5 text-muted-foreground"
								strokeWidth={1.8}
							/>
							<span>Data &amp; logs</span>
						</span>
					}
					description="Reveal the app data directory or the JSONL logs (rust + sidecar) in Finder — the first stop when something misbehaves."
				>
					<div className="flex items-center gap-1.5">
						<Button
							variant="outline"
							size="sm"
							disabled={!dataDir}
							onClick={() => dataDir && void revealPathInFinder(dataDir)}
						>
							Data dir
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!dataDir}
							onClick={() =>
								dataDir && void revealPathInFinder(`${dataDir}/logs`)
							}
						>
							Logs
						</Button>
					</div>
				</SettingsRow>
			</SettingsGroup>

			<h3 className="mt-2 font-medium text-muted-foreground text-small">
				Team cloud
			</h3>
			<SettingsGroup>
				<TeamCloudDiagnostics />

				<SettingsRow
					align="start"
					title={
						<span className="flex items-center gap-1.5">
							<Cloud
								className="size-3.5 text-muted-foreground"
								strokeWidth={1.8}
							/>
							<span>Reset team-cloud config</span>
						</span>
					}
					description="Clear the saved Worker URL, token, and team-mode flag, then reload — the next time you pick Team, setup starts fresh. Remote containers / identities are unaffected."
				>
					<Button variant="outline" size="sm" onClick={handleResetTeamCloud}>
						Reset
					</Button>
				</SettingsRow>

				<SettingsRow
					align="start"
					title={
						<span className="flex items-center gap-1.5">
							<Container
								className="size-3.5 text-muted-foreground"
								strokeWidth={1.8}
							/>
							<span>Remote containers</span>
						</span>
					}
					description={
						<>
							List the Cloudflare Containers you've deployed, then delete
							leftovers.
							{containerError ? (
								<SettingsNotice tone="error">{containerError}</SettingsNotice>
							) : null}
							{containers && containers.length === 0 && !containerError ? (
								<SettingsNotice tone="info">
									No containers found.
								</SettingsNotice>
							) : null}
							{containers && containers.length > 0 ? (
								<div className="mt-2 flex flex-col gap-1">
									{containers.map((container, index) => (
										<div
											key={container.id ?? container.name ?? index}
											className="flex items-center justify-between gap-2 rounded-md border border-border/45 bg-card/60 px-2 py-1"
										>
											<code className="truncate text-mini">
												{container.name ?? container.id ?? "unknown"}
											</code>
											<Button
												variant="ghost"
												size="sm"
												disabled={!container.id}
												onClick={() =>
													container.id && void removeContainer(container.id)
												}
											>
												Delete
											</Button>
										</div>
									))}
								</div>
							) : null}
						</>
					}
				>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void loadContainers()}
						disabled={loadingContainers}
					>
						{loadingContainers ? "Loading…" : "List"}
					</Button>
				</SettingsRow>
			</SettingsGroup>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="confirmReset"
				description={
					<>
						<I18nText source="willPermanentlyDelete" />{" "}
						<strong>
							<I18nText source="allWorkspacesSessionsRepositories" />
						</strong>{" "}
						<I18nText source="fromDevelopmentDatabaseActionCannotUndone" />
					</>
				}
				confirmLabel={resetting ? "resetting" : "deleteEverything"}
				onConfirm={() => void handleReset()}
				loading={resetting}
			/>
		</>
	);
}
