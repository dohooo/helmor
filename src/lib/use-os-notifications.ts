import { useCallback, useRef } from "react";
import type { AppSettings } from "@/lib/settings";

type NotifyFn = (opts: { title: string; body: string }) => void;

/** Sends native OS notifications, gated by the `notifications` setting. */
export function useOsNotifications(settings: AppSettings): NotifyFn {
	const permissionCheckedRef = useRef(false);
	const permissionGrantedRef = useRef(false);

	return useCallback(
		({ title, body }: { title: string; body: string }) => {
			if (!settings.notifications) return;

			void (async () => {
				try {
					const { isPermissionGranted, requestPermission, sendNotification } =
						await import("@tauri-apps/plugin-notification");

					if (!permissionCheckedRef.current) {
						permissionCheckedRef.current = true;
						let granted = await isPermissionGranted();
						if (!granted) {
							const result = await requestPermission();
							granted = result === "granted";
						}
						permissionGrantedRef.current = granted;
					}

					if (!permissionGrantedRef.current) return;
					sendNotification({ title, body });
				} catch {
					// non-Tauri env or permission denied
				}
			})();
		},
		[settings.notifications],
	);
}
