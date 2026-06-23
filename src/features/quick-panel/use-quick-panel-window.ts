import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { hideQuickPanel } from "@/lib/api";
import { publishShellEvent, useShellEvent } from "@/shell/event-bus";

/**
 * Window-side behaviors of the quick panel: land on the start surface, react
 * to ⌘N, Esc-to-dismiss, and composer focus on every summon.
 */
export function useQuickPanelWindow({
	openWorkspaceStart,
}: {
	openWorkspaceStart: (opts?: { persist?: boolean }) => void;
}) {
	// The panel always boots onto the start surface — its whole purpose is a
	// fresh task. The main window's `lastSurface` restore doesn't apply here
	// (location persistence is disabled for this window, so `persist` is moot;
	// passing false keeps the intent explicit).
	const bootedRef = useRef(false);
	useEffect(() => {
		if (bootedRef.current) return;
		bootedRef.current = true;
		openWorkspaceStart({ persist: false });
	}, [openWorkspaceStart]);

	// ⌘N / ⌘⇧N publish this event. In the main window the sidebar navigates to
	// the start surface; the panel has no sidebar, so navigate here. The mode
	// override ("just chat") is consumed by the start-surface controller.
	useShellEvent("open-new-workspace", () => {
		openWorkspaceStart({ persist: false });
	});

	// Esc dismisses the panel — unless something closer to the focus already
	// handled it (typeahead popups, source preview, …) and preventDefault'ed.
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			void hideQuickPanel();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	// The window is hidden, not destroyed, between summons — refocus the
	// composer every time it comes back.
	useEffect(() => {
		const unlistenPromise = getCurrentWindow().listen("tauri://focus", () => {
			publishShellEvent({ type: "focus-composer" });
		});
		return () => {
			void unlistenPromise.then((unlisten) => unlisten());
		};
	}, []);
}
