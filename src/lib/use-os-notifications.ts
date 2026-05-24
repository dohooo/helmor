import { useCallback, useRef } from "react";
import { playNotificationSound } from "@/lib/notification-sound";
import type { AppSettings } from "@/lib/settings";

type NotifyFn = (opts: { title: string; body: string }) => void;

/** Sends native OS notifications, gated by the `notifications` setting.
 *  Also plays the user's chosen sound effect (when not "off"). */
export function useOsNotifications(settings: AppSettings): NotifyFn {
	const permissionRequestedRef = useRef(false);

	return useCallback(
		({ title, body }: { title: string; body: string }) => {
			if (!settings.notifications) return;

			void (async () => {
				try {
					const { isPermissionGranted, requestPermission, sendNotification } =
						await import("@tauri-apps/plugin-notification");

					let granted = await isPermissionGranted();
					if (!granted) {
						// Only pop the OS permission dialog once per session
						if (permissionRequestedRef.current) return;
						permissionRequestedRef.current = true;
						granted = (await requestPermission()) === "granted";
					}

					if (!granted) return;
					sendNotification({ title, body });
					playNotificationSound(settings.notificationSound);
				} catch (err) {
					console.warn("[os-notification] failed to send:", err);
				}
			})();
		},
		[settings.notifications, settings.notificationSound],
	);
}
