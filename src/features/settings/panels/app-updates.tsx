import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	type AppUpdateStatus,
	checkForAppUpdate,
	getAppUpdateStatus,
	installDownloadedAppUpdate,
	listenAppUpdateStatus,
} from "@/lib/api";
import { useSettings } from "@/lib/settings";

function formatStatusDescription(status: AppUpdateStatus): string {
	if (!status.configured) {
		return "Updater is not configured in this build.";
	}

	switch (status.stage) {
		case "checking":
			return "Checking GitHub releases in the background.";
		case "downloading":
			return status.update
				? `Downloading ${status.update.version} in the background.`
				: "Downloading an update in the background.";
		case "downloaded":
			return status.update
				? `${status.update.version} has been downloaded and is ready to install.`
				: "The latest update has been downloaded and is ready to install.";
		case "error":
			return status.lastError ?? "The last update check failed.";
		case "disabled":
			return status.autoUpdateEnabled
				? "Automatic update checks are waiting for updater configuration."
				: "Automatic update checks are disabled.";
		default:
			return "Checks GitHub releases, downloads updates quietly, then prompts when ready.";
	}
}

export function AppUpdatesPanel() {
	const { settings, updateSettings } = useSettings();
	const [status, setStatus] = useState<AppUpdateStatus | null>(null);
	const [checking, setChecking] = useState(false);
	const [installing, setInstalling] = useState(false);

	useEffect(() => {
		let mounted = true;
		let cleanup: (() => void) | undefined;

		void getAppUpdateStatus().then((nextStatus) => {
			if (mounted) setStatus(nextStatus);
		});

		void listenAppUpdateStatus((nextStatus) => {
			if (mounted) setStatus(nextStatus);
		}).then((unlisten) => {
			cleanup = unlisten;
		});

		return () => {
			mounted = false;
			cleanup?.();
		};
	}, []);

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="text-[13px] font-medium leading-snug text-foreground">
							App Updates
						</div>
						<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
							{status
								? formatStatusDescription(status)
								: "Loading updater status…"}
						</div>
						{status?.update && (
							<div className="mt-2 text-[12px] text-muted-foreground">
								Current {status.update.currentVersion} · Available{" "}
								{status.update.version}
							</div>
						)}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								setChecking(true);
								void checkForAppUpdate(true)
									.then((nextStatus) => {
										setStatus(nextStatus);
										if (nextStatus.stage === "idle") {
											toast.success("Helmor is up to date");
										}
										if (nextStatus.stage === "error") {
											toast.error("Update check failed", {
												description:
													nextStatus.lastError ??
													"Unable to check for updates.",
											});
										}
									})
									.finally(() => setChecking(false));
							}}
							disabled={checking || installing}
						>
							{checking ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
							Check now
						</Button>
						{status?.stage === "downloaded" && (
							<Button
								size="sm"
								onClick={() => {
									setInstalling(true);
									void installDownloadedAppUpdate()
										.then(setStatus)
										.catch((error: unknown) => {
											toast.error("Install failed", {
												description:
													error instanceof Error
														? error.message
														: "Unable to install the downloaded update.",
											});
										})
										.finally(() => setInstalling(false));
								}}
								disabled={checking || installing}
							>
								Update and restart
							</Button>
						)}
						{status?.update?.releaseUrl && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => void openUrl(status.update?.releaseUrl ?? "")}
							>
								Change log
							</Button>
						)}
					</div>
				</div>
			</div>

			<div className="flex items-center justify-between rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
				<div className="mr-8">
					<div className="text-[13px] font-medium leading-snug text-foreground">
						Automatic checks
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						Check for updates after launch, on focus, and on the background
						timer.
					</div>
				</div>
				<Switch
					checked={settings.autoUpdateEnabled}
					onCheckedChange={(checked) =>
						updateSettings({ autoUpdateEnabled: checked })
					}
				/>
			</div>

			<div className="flex items-center justify-between rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
				<div className="mr-8">
					<div className="text-[13px] font-medium leading-snug text-foreground">
						Check on launch
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						Run a background check shortly after Helmor starts.
					</div>
				</div>
				<Switch
					checked={settings.autoUpdateCheckOnLaunch}
					onCheckedChange={(checked) =>
						updateSettings({ autoUpdateCheckOnLaunch: checked })
					}
					disabled={!settings.autoUpdateEnabled}
				/>
			</div>

			<div className="flex items-center justify-between rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
				<div className="mr-8">
					<div className="text-[13px] font-medium leading-snug text-foreground">
						Check when Helmor is focused
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						Use a throttled focus/resume trigger to pick up freshly published
						releases.
					</div>
				</div>
				<Switch
					checked={settings.autoUpdateCheckOnFocus}
					onCheckedChange={(checked) =>
						updateSettings({ autoUpdateCheckOnFocus: checked })
					}
					disabled={!settings.autoUpdateEnabled}
				/>
			</div>

			<div className="flex items-center justify-between rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
				<div className="mr-8">
					<div className="text-[13px] font-medium leading-snug text-foreground">
						Background interval
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						Minimum minutes between background checks.
					</div>
				</div>
				<Input
					type="number"
					min={1}
					step={1}
					value={String(settings.autoUpdateIntervalMinutes)}
					onChange={(event) =>
						updateSettings({
							autoUpdateIntervalMinutes: Math.max(
								1,
								Number(event.target.value) || 1,
							),
						})
					}
					className="w-28 bg-muted/30 text-right text-[13px] text-foreground"
					disabled={!settings.autoUpdateEnabled}
				/>
			</div>
		</div>
	);
}
