import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { syncGlobalHotkey } from "@/lib/api";
import type { ShortcutOverrides } from "@/lib/settings";
import { getShortcut, updateShortcutOverride } from "./registry";

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
	const globalHotkey = getShortcut(shortcuts, "global.hotkey");
	const lastFailureRef = useRef<string | null>(null);

	useEffect(() => {
		if (!isLoaded) return;

		void syncGlobalHotkey(globalHotkey)
			.then(() => {
				lastFailureRef.current = null;
			})
			.catch((error) => {
				const key = globalHotkey ?? "<disabled>";
				if (lastFailureRef.current !== key) {
					lastFailureRef.current = key;
					toast.error(
						error instanceof Error
							? error.message
							: "Failed to register global hotkey",
					);
				}

				if (globalHotkey) {
					const nextShortcuts = updateShortcutOverride(
						shortcuts,
						"global.hotkey",
						null,
					);
					updateShortcuts(nextShortcuts as ShortcutOverrides);
				}
			});
	}, [globalHotkey, isLoaded, shortcuts, updateShortcuts]);
}
