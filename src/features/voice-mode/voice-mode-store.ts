import { useSyncExternalStore } from "react";

/**
 * Module-level voice-mode state. We avoid React Context here so toggling
 * the voice UI doesn't force a global re-render of every consumer in the
 * provider tree -- only components that subscribe via `useVoiceModeActive`
 * re-render.
 *
 * Single instance per process is fine: Helmor runs as a single Tauri
 * webview, no SSR.
 */

let active = false;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getActive(): boolean {
	return active;
}

export const voiceModeStore = {
	subscribe,
	getActive,
	setActive(next: boolean): void {
		if (active === next) return;
		active = next;
		emit();
	},
	toggle(): void {
		active = !active;
		emit();
	},
};

export function useVoiceModeActive(): boolean {
	return useSyncExternalStore(subscribe, getActive, getActive);
}
