import { useCallback, useEffect, useState } from "react";

/// Open/close state for the workspace search panel. Kept as its own
/// hook so App.tsx can drive opening from a global shortcut and the
/// panel itself can drive closing from Esc / overlay clicks without
/// the two surfaces tripping over each other.
export type WorkspaceSearchPanelState = {
	isOpen: boolean;
	open: () => void;
	close: () => void;
	toggle: () => void;
};

export function useWorkspaceSearchPanel(): WorkspaceSearchPanelState {
	const [isOpen, setIsOpen] = useState(false);
	const open = useCallback(() => setIsOpen(true), []);
	const close = useCallback(() => setIsOpen(false), []);
	const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
	// Close-on-Escape handler. Lives at hook level so the panel
	// component itself doesn't have to re-register on every render —
	// and so `useAppShortcuts`'s capture-phase listener doesn't
	// trample the panel-specific shortcut (Esc isn't in the shortcut
	// registry, so this is the only place it's handled).
	useEffect(() => {
		if (!isOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setIsOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isOpen]);
	return { isOpen, open, close, toggle };
}
