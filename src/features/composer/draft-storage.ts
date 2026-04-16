import type { SerializedEditorState } from "lexical";

const STORAGE_PREFIX = "helmor:composer-draft:";

export function getComposerDraftStorageKey(contextKey: string): string {
	return `${STORAGE_PREFIX}${contextKey}`;
}

export function loadPersistedDraft(
	contextKey: string,
): SerializedEditorState | null {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(
			getComposerDraftStorageKey(contextKey),
		);
		if (!raw) {
			return null;
		}

		return JSON.parse(raw) as SerializedEditorState;
	} catch {
		return null;
	}
}

export function savePersistedDraft(
	contextKey: string,
	editorState: SerializedEditorState,
): void {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.localStorage.setItem(
			getComposerDraftStorageKey(contextKey),
			JSON.stringify(editorState),
		);
	} catch {
		// ignore
	}
}

export function clearPersistedDraft(contextKey: string): void {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.localStorage.removeItem(getComposerDraftStorageKey(contextKey));
	} catch {
		// ignore
	}
}
