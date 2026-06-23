import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	type AppUpdateStatus,
	checkForAppUpdate,
	getAppUpdateStatus,
	installDownloadedAppUpdate,
	listenAppUpdateStatus,
} from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import { SettingsNotice, SettingsRow } from "../components/settings-row";

function formatStatusDescription(
	status: AppUpdateStatus,
	t: (source: string) => string,
): string {
	if (!status.configured) {
		return t("updaterNotConfiguredBuild");
	}

	switch (status.stage) {
		case "checking":
			return t("checkingGithubReleasesBackground");
		case "downloading":
			return status.update
				? t("downloadingVersionBackground").replace(
						"{version}",
						status.update.version,
					)
				: t("downloadingUpdateBackground");
		case "downloaded":
			return status.update
				? t("versionHasBeenDownloadedReadyInstall").replace(
						"{version}",
						status.update.version,
					)
				: t("latestUpdateHasBeenDownloadedReady");
		case "error":
			return status.lastError ?? t("lastUpdateCheckFailed");
		case "disabled":
			return status.autoUpdateEnabled
				? t("automaticUpdateChecksWaitingUpdaterConfiguration")
				: t("automaticUpdateChecksDisabled");
		default:
			return t("checksGithubReleasesDownloadsUpdatesQuietly");
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DownloadProgressBar({ status }: { status: AppUpdateStatus }) {
	if (status.stage !== "downloading") return null;
	const progress = status.progress;
	const downloaded = progress?.downloaded ?? 0;
	const total = progress?.total ?? null;
	const hasTotal = typeof total === "number" && total > 0;
	const percent = hasTotal
		? Math.min(100, Math.round((downloaded / total) * 100))
		: null;

	return (
		<div className="mt-2 max-w-[280px]">
			<div className="h-1 w-full overflow-hidden rounded-full bg-muted/40">
				{percent !== null ? (
					<div
						className="h-full bg-foreground/70 transition-[width] duration-200 ease-out"
						style={{ width: `${percent}%` }}
					/>
				) : (
					<div className="h-full w-1/3 animate-pulse bg-foreground/50" />
				)}
			</div>
			<div className="mt-1 text-mini tabular-nums text-muted-foreground">
				{hasTotal
					? `${formatBytes(downloaded)} / ${formatBytes(total)} · ${percent}%`
					: formatBytes(downloaded)}
			</div>
		</div>
	);
}

export function AppUpdatesPanel() {
	const { t } = useI18n();
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
			// If the panel unmounted before listen() resolved, the cleanup
			// below already ran with cleanup still undefined, so detach this
			// unlisten now instead of leaking a backend listener. Mirrors
			// use-ui-sync-bridge.ts.
			if (!mounted) {
				unlisten();
				return;
			}
			cleanup = unlisten;
		});

		return () => {
			mounted = false;
			cleanup?.();
		};
	}, []);

	const stage = status?.stage;
	const isAutoChecking = stage === "checking";
	const isDownloading = stage === "downloading";
	const isInstallingStage = stage === "installing";
	const checkBusy = checking || isAutoChecking;
	const installBusy = installing || isInstallingStage;
	const anyBusy = checkBusy || isDownloading || installBusy;

	const checkLabel = isDownloading
		? t("downloading")
		: installBusy
			? t("installing")
			: checkBusy
				? t("checking")
				: t("checkNow");

	return (
		<SettingsRow
			align="start"
			title="appUpdates"
			description={
				<>
					{status
						? formatStatusDescription(status, t)
						: t("loadingUpdaterStatus")}
					{status?.update ? (
						<SettingsNotice tone="info">
							{t("current")} {status.update.currentVersion} · {t("available")}{" "}
							{status.update.version}
						</SettingsNotice>
					) : null}
					{status ? <DownloadProgressBar status={status} /> : null}
				</>
			}
		>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setChecking(true);
						void checkForAppUpdate(true)
							.then((nextStatus) => {
								setStatus(nextStatus);
								if (nextStatus.stage === "idle") {
									toast.success(t("helmorUpDate"));
								}
								if (nextStatus.stage === "error") {
									toast.error(t("updateCheckFailed"), {
										description:
											nextStatus.lastError ?? t("unableCheckUpdates"),
									});
								}
							})
							.finally(() => setChecking(false));
					}}
					disabled={anyBusy}
				>
					{anyBusy ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<RefreshCw className="size-3.5" />
					)}
					{checkLabel}
				</Button>
				{status?.stage === "downloaded" && (
					<Button
						size="sm"
						onClick={() => {
							setInstalling(true);
							void installDownloadedAppUpdate()
								.then(setStatus)
								.catch((error: unknown) => {
									toast.error(t("installFailed"), {
										description:
											error instanceof Error
												? error.message
												: t("unableInstallDownloadedUpdate"),
									});
								})
								.finally(() => setInstalling(false));
						}}
						disabled={anyBusy}
					>
						<I18nText source="updateRestart" />
					</Button>
				)}
				{status?.update?.releaseUrl && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => void openUrl(status.update?.releaseUrl ?? "")}
					>
						<I18nText source="changeLog" />
					</Button>
				)}
			</div>
		</SettingsRow>
	);
}
