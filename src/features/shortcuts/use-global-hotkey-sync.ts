import { useEffect, useRef } from "react";
import { type OsGlobalHotkeyId, syncGlobalHotkey } from "@/lib/api";
import { toastCaughtError } from "@/lib/error-toast";
import { translateSource } from "@/lib/i18n";
import type { ShortcutOverrides } from "@/lib/settings";
import { isQuickPanelWindow } from "@/lib/window-role";
import { getShortcut, updateShortcutOverride } from "./registry";

/** Shortcut ids registered at the OS level by the Rust backend. */
const OS_GLOBAL_HOTKEY_IDS: readonly OsGlobalHotkeyId[] = [
	"global.hotkey",
	"quickPanel.hotkey",
];

type GlobalHotkeySyncOptions = {
	isLoaded: boolean;
	shortcuts: ShortcutOverrides;
	updateShortcuts: (shortcuts: ShortcutOverrides) => void;
};

export function useGlobalHotkeySync({
	isLoaded,
	shortcuts,
	updateShortcuts,
}: GlobalHotkeySyncOptions) {
	const lastFailureRef = useRef<Map<OsGlobalHotkeyId, string>>(new Map());

	useEffect(() => {
		// The main window owns OS-hotkey registration; the quick panel mounts
		// the same shell stack but must not double-drive (or race) the sync.
		if (!isLoaded || isQuickPanelWindow) return;

		for (const id of OS_GLOBAL_HOTKEY_IDS) {
			const hotkey = getShortcut(shortcuts, id);
			void syncGlobalHotkey(id, hotkey)
				.then(() => {
					lastFailureRef.current.delete(id);
				})
				.catch((error) => {
					const key = hotkey ?? "<disabled>";
					if (lastFailureRef.current.get(id) !== key) {
						lastFailureRef.current.set(id, key);
						// DF-R6-A hygiene: silent for the typed companion-asleep error
						// (defense-in-depth — sync_global_hotkey is LOCAL_ONLY now, so
						// it no longer routes to the sleeping container), deduped id
						// for any real registration failure.
						toastCaughtError(
							error,
							error instanceof Error
								? error.message
								: translateSource("miscFailedRegisterGlobalHotkey"),
						);
					}

					if (hotkey) {
						const nextShortcuts = updateShortcutOverride(shortcuts, id, null);
						updateShortcuts(nextShortcuts as ShortcutOverrides);
					}
				});
		}
	}, [isLoaded, shortcuts, updateShortcuts]);
}
