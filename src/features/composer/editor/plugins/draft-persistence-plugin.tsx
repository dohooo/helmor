import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { SerializedEditorState } from "lexical";
import { useCallback, useEffect, useRef } from "react";
import {
	clearPersistedDraft,
	loadPersistedDraft,
	savePersistedDraft,
} from "@/features/composer/draft-storage";
import type { ComposerCustomTag } from "@/lib/composer-insert";
import { $setEditorContent, draftCache } from "../../editor-ops";
import { $extractComposerContent } from "../utils";

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
	const hydratedContextKeyRef = useRef<string | null>(null);
	const saveTimerRef = useRef<number | null>(null);
	const prevRestoreNonceRef = useRef(restoreNonce);

	const persistEditorState = useCallback(
		(targetContextKey: string, editorState: SerializedEditorState) => {
			draftCache.set(targetContextKey, editorState);
			savePersistedDraft(targetContextKey, editorState);
		},
		[],
	);

	const clearDraftState = useCallback((targetContextKey: string) => {
		draftCache.delete(targetContextKey);
		clearPersistedDraft(targetContextKey);
	}, []);

	const flushDraft = useCallback(
		(targetContextKey: string) => {
			if (!targetContextKey) {
				return;
			}

			const editorState = editor.getEditorState().toJSON();
			editor.read(() => {
				const content = $extractComposerContent();
				if (hasMeaningfulContent(content)) {
					persistEditorState(targetContextKey, editorState);
					return;
				}

				clearDraftState(targetContextKey);
			});
		},
		[clearDraftState, editor, persistEditorState],
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

	const restoreDraftState = useCallback(
		(targetContextKey: string) => {
			const cached =
				draftCache.get(targetContextKey) ??
				loadPersistedDraft(targetContextKey);
			if (cached) {
				draftCache.set(targetContextKey, cached);
				editor.setEditorState(editor.parseEditorState(cached));
			} else {
				editor.update(() => {
					$setEditorContent(
						restoreDraft ?? "",
						restoreImages,
						restoreFiles,
						restoreCustomTags,
					);
				});
			}

			hydratedContextKeyRef.current = targetContextKey;
		},
		[editor, restoreCustomTags, restoreDraft, restoreFiles, restoreImages],
	);

	useEffect(() => {
		const previousContextKey = activeContextKeyRef.current;
		if (previousContextKey && previousContextKey !== contextKey) {
			cancelScheduledFlush();
			flushDraft(previousContextKey);
		}

		activeContextKeyRef.current = contextKey;
		restoreDraftState(contextKey);
	}, [cancelScheduledFlush, contextKey, flushDraft, restoreDraftState]);

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

		editor.update(() => {
			$setEditorContent(
				restoreDraft ?? "",
				restoreImages,
				restoreFiles,
				restoreCustomTags,
			);
		});
		hydratedContextKeyRef.current = contextKey;
	}, [
		contextKey,
		editor,
		restoreCustomTags,
		restoreDraft,
		restoreFiles,
		restoreImages,
		restoreNonce,
	]);

	useEffect(() => {
		return editor.registerUpdateListener(() => {
			if (hydratedContextKeyRef.current !== contextKey) {
				return;
			}

			scheduleFlush(contextKey);
		});
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
