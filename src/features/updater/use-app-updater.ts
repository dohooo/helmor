import { openUrl } from "@tauri-apps/plugin-opener";
import { createElement, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
	type AppUpdateStatus,
	getAppUpdateStatus,
	installDownloadedAppUpdate,
	listenAppUpdateStatus,
} from "@/lib/api";

function toastIdForUpdate(status: AppUpdateStatus): string | null {
	return status.update ? `app-update-${status.update.version}` : null;
}

function isDownloadedUpdateReady(
	status: AppUpdateStatus | null | undefined,
): status is AppUpdateStatus & {
	update: NonNullable<AppUpdateStatus["update"]>;
} {
	return status?.stage === "downloaded" && status.update != null;
}

function showDownloadedUpdateToast(
	status: AppUpdateStatus & {
		update: NonNullable<AppUpdateStatus["update"]>;
	},
) {
	toast("Update ready to install", {
		id: toastIdForUpdate(status) ?? undefined,
		description: `Helmor ${status.update.version} has been downloaded.`,
		action: createElement(
			"button",
			{
				type: "button",
				"data-button": true,
				"data-action": true,
				onClick: () => {
					void installDownloadedAppUpdate().catch((error: unknown) => {
						toast.error("Install failed", {
							description:
								error instanceof Error
									? error.message
									: "Unable to install the downloaded update.",
						});
					});
				},
			},
			"Update and restart",
		),
		cancel: status.update.releaseUrl
			? createElement(
					"button",
					{
						type: "button",
						"data-button": true,
						"data-cancel": true,
						onClick: () => void openUrl(status.update.releaseUrl ?? ""),
					},
					"View change log",
				)
			: undefined,
		duration: Number.POSITIVE_INFINITY,
	});
}

export function useAppUpdater() {
	const notifiedVersionRef = useRef<string | null>(null);

	useEffect(() => {
		let cleanup: (() => void) | undefined;
		let mounted = true;

		const handleStatus = (status: AppUpdateStatus | null | undefined) => {
			if (!mounted || !isDownloadedUpdateReady(status)) return;
			if (notifiedVersionRef.current === status.update.version) return;

			notifiedVersionRef.current = status.update.version;

			showDownloadedUpdateToast(status);
		};

		void getAppUpdateStatus()
			.then(handleStatus)
			.catch(() => {});
		void listenAppUpdateStatus(handleStatus)
			.then((unlisten) => {
				cleanup = unlisten;
			})
			.catch(() => {});

		return () => {
			mounted = false;
			cleanup?.();
		};
	}, []);
}
