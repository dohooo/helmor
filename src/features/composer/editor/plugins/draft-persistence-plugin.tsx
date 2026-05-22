import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { SerializedEditorState } from "lexical";
import { useCallback, useEffect, useRef } from "react";
import {
	clearPersistedDraft,
	loadPersistedDraft,
	savePersistedDraft,
} from "@/features/composer/draft-storage";
import type { ComposerCustomTag } from "@/lib/composer-insert";
import { $setEditorContent } from "../../editor-ops";
import { $extractComposerContent } from "../utils";
import {
	HISTORY_RECALL_RESTORE_TAG,
	HISTORY_RECALL_TAG,
} from "./history-recall-plugin";

const SAVE_DELAY_MS = 400;

type DraftPersistencePluginProps = {
	contextKey: string;
	restoreDraft?: string | null;
	restoreImages?: string[];
	restoreFiles?: string[];
	restoreCustomTags?: ComposerCustomTag[];
	restoreNonce?: number;
};

function hasMeaningfulContent({
	text,
	images,
	files,
	customTags,
}: {
	text: string;
	images: string[];
	files: string[];
	customTags: ComposerCustomTag[];
}): boolean {
	return Boolean(text || images.length || files.length || customTags.length);
}

export function DraftPersistencePlugin({
	contextKey,
	restoreDraft,
	restoreImages = [],
	restoreFiles = [],
	restoreCustomTags = [],
	restoreNonce = 0,
}: DraftPersistencePluginProps) {
	const [editor] = useLexicalComposerContext();
	const activeContextKeyRef = useRef<string | null>(null);
	const initializedContextKeyRef = useRef<string | null>(null);
	const saveTimerRef = useRef<number | null>(null);
	const prevRestoreNonceRef = useRef(restoreNonce);
	const recallActiveRef = useRef(false);

	const clearDraftState = useCallback((targetContextKey: string) => {
		clearPersistedDraft(targetContextKey);
	}, []);

	const flushDraft = useCallback(
		(targetContextKey: string) => {
			if (!targetContextKey) {
				return;
			}

			if (recallActiveRef.current) {
				return;
			}
			const editorState = editor.getEditorState().toJSON();
			editor.read(() => {
				const content = $extractComposerContent();
				if (hasMeaningfulContent(content)) {
					savePersistedDraft(
						targetContextKey,
						editorState as SerializedEditorState,
					);
					return;
				}

				clearDraftState(targetContextKey);
			});
		},
		[clearDraftState, editor],
	);

	const cancelScheduledFlush = useCallback(() => {
		if (saveTimerRef.current !== null) {
			window.clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
	}, []);

	const scheduleFlush = useCallback(
		(targetContextKey: string) => {
			cancelScheduledFlush();
			saveTimerRef.current = window.setTimeout(() => {
				saveTimerRef.current = null;
				flushDraft(targetContextKey);
			}, SAVE_DELAY_MS);
		},
		[cancelScheduledFlush, flushDraft],
	);

	const applyRestorePayload = useCallback(() => {
		editor.update(() => {
			$setEditorContent(
				restoreDraft ?? "",
				restoreImages,
				restoreFiles,
				restoreCustomTags,
			);
		});
	}, [editor, restoreCustomTags, restoreDraft, restoreFiles, restoreImages]);

	const restorePersistedDraft = useCallback(
		(targetContextKey: string): boolean => {
			const persisted = loadPersistedDraft(targetContextKey);
			if (!persisted) {
				return false;
			}

			try {
				editor.setEditorState(editor.parseEditorState(persisted));
				return true;
			} catch {
				clearPersistedDraft(targetContextKey);
				return false;
			}
		},
		[editor],
	);

	useEffect(() => {
		const previousContextKey = activeContextKeyRef.current;
		if (previousContextKey && previousContextKey !== contextKey) {
			cancelScheduledFlush();
			flushDraft(previousContextKey);
			recallActiveRef.current = false;
			initializedContextKeyRef.current = null;
		}

		activeContextKeyRef.current = contextKey;
		if (initializedContextKeyRef.current === contextKey) {
			return;
		}

		initializedContextKeyRef.current = contextKey;
		if (!restorePersistedDraft(contextKey)) {
			applyRestorePayload();
		}
	}, [
		applyRestorePayload,
		cancelScheduledFlush,
		contextKey,
		flushDraft,
		restorePersistedDraft,
	]);

	useEffect(() => {
		if (restoreNonce === prevRestoreNonceRef.current) {
			return;
		}

		prevRestoreNonceRef.current = restoreNonce;
		if (
			!restoreDraft &&
			restoreImages.length === 0 &&
			restoreFiles.length === 0 &&
			restoreCustomTags.length === 0
		) {
			return;
		}

		applyRestorePayload();
	}, [applyRestorePayload, restoreNonce]);

	useEffect(() => {
		return editor.registerUpdateListener(
			({ tags, dirtyElements, dirtyLeaves }) => {
				// Recall plugin mutations carry HISTORY_RECALL_TAG — those are
				// browsing previously-sent prompts, not authoring a new draft.
				// Persisting them would overwrite the user's in-progress draft.
				if (tags.has(HISTORY_RECALL_TAG)) {
					recallActiveRef.current = true;
					return;
				}
				if (tags.has(HISTORY_RECALL_RESTORE_TAG)) {
					recallActiveRef.current = false;
					return;
				}
				const hasContentChange = dirtyElements.size > 0 || dirtyLeaves.size > 0;
				if (recallActiveRef.current && !hasContentChange) return;
				if (hasContentChange) recallActiveRef.current = false;
				scheduleFlush(contextKey);
			},
		);
	}, [contextKey, editor, scheduleFlush]);

	useEffect(() => {
		return () => {
			cancelScheduledFlush();
			const activeContextKey = activeContextKeyRef.current;
			if (activeContextKey) {
				flushDraft(activeContextKey);
			}
		};
	}, [cancelScheduledFlush, flushDraft]);

	return null;
}
