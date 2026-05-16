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
let mainSurfaceVisible = false;
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

function getMainSurfaceVisible(): boolean {
	return mainSurfaceVisible;
}

export const voiceModeStore = {
	subscribe,
	getActive,
	getMainSurfaceVisible,
	setActive(next: boolean): void {
		if (active === next) return;
		active = next;
		if (!next) {
			mainSurfaceVisible = false;
		}
		emit();
	},
	setMainSurfaceVisible(next: boolean): void {
		if (mainSurfaceVisible === next) return;
		mainSurfaceVisible = next;
		emit();
	},
	toggle(): void {
		this.setActive(!active);
	},
};

export function useVoiceModeActive(): boolean {
	return useSyncExternalStore(subscribe, getActive, getActive);
}

export function useVoiceModeBarVisible(): boolean {
	return useSyncExternalStore(
		subscribe,
		getMainSurfaceVisible,
		getMainSurfaceVisible,
	);
}
