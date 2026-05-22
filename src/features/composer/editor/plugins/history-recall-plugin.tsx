/**
 * Shell-style input recall: ArrowUp/ArrowDown at the editor's first /
 * last line walks back/forward through previously submitted prompts
 * for the current session (per-session scope).
 *
 * Behavior matches bash/zsh/fish:
 *   - Up at first line (or empty input): step to older history. The
 *     content the user had in the composer before the first Up gets
 *     snapshotted as the "in-progress draft" so a later Down past the
 *     newest entry restores it verbatim.
 *   - Down at last line: step to newer history; past the newest entry
 *     the in-progress draft is restored and history mode exits.
 *   - Mid-content Up/Down (cursor not at the line boundary) falls
 *     through to Lexical's default caret movement.
 *   - User edits inside a recalled entry exit history mode and drop
 *     the saved in-progress draft — the recalled+edited text becomes
 *     the new working draft.
 *
 * Guards (mirrored from `SubmitPlugin` so the three pieces of keyboard
 * UX stay consistent):
 *   - Active typeahead popup (slash / @-mention / add-dir picker)
 *     keeps Arrow keys for menu navigation.
 *   - IME composition (`isComposing` / `keyCode === 229`) yields to
 *     the browser's candidate selector.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
	$getRoot,
	COMMAND_PRIORITY_LOW,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	type SerializedEditorState,
} from "lexical";
import { useCallback, useEffect, useRef } from "react";
import { clearPersistedDraft, savePersistedDraft } from "../../draft-storage";
import { $setEditorContent, $setEditorContentParts } from "../../editor-ops";
import type { InputHistoryEntry } from "../../input-history";
import { $extractComposerContent } from "../utils";

/** Update tag stamped on every editor mutation the recall plugin
 *  performs (applying a history entry, restoring the in-progress draft).
 *  Sibling plugins watch for this tag to suppress side effects — most
 *  importantly `DraftPersistencePlugin`, which would otherwise overwrite
 *  the saved draft with whatever recalled prompt is currently on screen. */
export const HISTORY_RECALL_TAG = "helmor-input-recall";
export const HISTORY_RECALL_RESTORE_TAG = "helmor-input-recall-restore";

const TYPEAHEAD_SELECTABLE_SELECTOR = "[data-typeahead-popup] [cmdk-item]";

function isTypeaheadSelectable(): boolean {
	if (typeof document === "undefined") return false;
	return document.querySelector(TYPEAHEAD_SELECTABLE_SELECTOR) !== null;
}

function contentVerticalBounds(rootEl: HTMLElement): {
	top: number;
	bottom: number;
} {
	const rootRect = rootEl.getBoundingClientRect();
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const child of Array.from(rootEl.children)) {
		const rect = child.getBoundingClientRect();
		if (
			rect.top === 0 &&
			rect.bottom === 0 &&
			rect.width === 0 &&
			rect.height === 0
		) {
			continue;
		}
		top = Math.min(top, rect.top);
		bottom = Math.max(bottom, rect.bottom);
	}
	if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
		return { top: rootRect.top, bottom: rootRect.bottom };
	}
	return { top, bottom };
}

function caretLinePosition(rootEl: HTMLElement): {
	atFirstLine: boolean;
	atLastLine: boolean;
} {
	// Fallback treats the caret as "on both boundaries" — the shell-style
	// recall handler then runs on every Up/Down regardless of position.
	// That's the right behavior for jsdom (no layout) and the empty-editor
	// case (no measurable caret), and harmless in production for the
	// single-line case where first === last line.
	const fallback = { atFirstLine: true, atLastLine: true };
	if (typeof window === "undefined") return fallback;
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return fallback;
	let range: Range;
	try {
		range = selection.getRangeAt(0).cloneRange();
	} catch {
		return fallback;
	}
	if (!rootEl.contains(range.startContainer)) return fallback;
	range.collapse(true);
	if (typeof range.getBoundingClientRect !== "function") return fallback;
	let caretRect: DOMRect;
	try {
		caretRect = range.getBoundingClientRect();
	} catch {
		return fallback;
	}
	if (
		caretRect.top === 0 &&
		caretRect.left === 0 &&
		caretRect.width === 0 &&
		caretRect.height === 0
	) {
		const container =
			range.startContainer instanceof Element
				? range.startContainer
				: (range.startContainer.parentElement ?? rootEl);
		try {
			caretRect = container.getBoundingClientRect();
		} catch {
			return fallback;
		}
	}
	const contentBounds = contentVerticalBounds(rootEl);
	const lineHeightRaw = parseFloat(getComputedStyle(rootEl).lineHeight);
	const lineHeight =
		Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : 20;
	const threshold = lineHeight * 0.5;
	return {
		atFirstLine: caretRect.top - contentBounds.top < threshold,
		atLastLine: contentBounds.bottom - caretRect.bottom < threshold,
	};
}

export const historyRecallTestUtils = {
	caretLinePosition,
};

type Props = {
	/** Returns the per-session recall list, most-recent first. Called
	 *  lazily on each ArrowUp/Down so the plugin always sees the latest
	 *  cache without needing to re-render on every cache update. */
	getHistory: () => readonly InputHistoryEntry[];
	/** Resets recall state when the parent swaps sessions (a new
	 *  `contextKey` means a new history scope). */
	scopeKey: string;
};

export function HistoryRecallPlugin({ getHistory, scopeKey }: Props) {
	const [editor] = useLexicalComposerContext();

	// -1 = not in recall mode; 0 = most recent; history.length - 1 = oldest.
	const indexRef = useRef<number>(-1);
	const pendingDraftRef = useRef<SerializedEditorState | null>(null);
	// Wrap `getHistory` in a ref so a fresh function identity from the
	// parent on every render doesn't re-register the command listeners.
	const getHistoryRef = useRef(getHistory);
	useEffect(() => {
		getHistoryRef.current = getHistory;
	}, [getHistory]);

	const exitRecallMode = useCallback(() => {
		indexRef.current = -1;
		pendingDraftRef.current = null;
	}, []);

	// Drop recall state whenever the composer's scope changes.
	useEffect(() => {
		exitRecallMode();
	}, [exitRecallMode, scopeKey]);

	const applyEntry = useCallback(
		(entry: InputHistoryEntry) => {
			editor.update(
				() => {
					$setEditorContentParts(entry.parts);
					$getRoot().selectEnd();
				},
				{ tag: HISTORY_RECALL_TAG },
			);
		},
		[editor],
	);

	const restoreDraft = useCallback(
		(serialized: SerializedEditorState | null) => {
			if (serialized) {
				try {
					const parsed = editor.parseEditorState(serialized);
					editor.setEditorState(parsed, { tag: HISTORY_RECALL_RESTORE_TAG });
					editor.update(
						() => {
							$getRoot().selectEnd();
						},
						{ tag: HISTORY_RECALL_RESTORE_TAG },
					);
					return;
				} catch {
					// Fall through to empty restore.
				}
			}
			editor.update(
				() => {
					$setEditorContent("", [], [], []);
				},
				{ tag: HISTORY_RECALL_RESTORE_TAG },
			);
		},
		[editor],
	);

	const snapshotCurrentDraft = useCallback((): SerializedEditorState => {
		return editor.getEditorState().toJSON();
	}, [editor]);

	const handleArrow = useCallback(
		(direction: "up" | "down", event: KeyboardEvent | null): boolean => {
			if (event?.isComposing || event?.keyCode === 229) return false;
			if (
				event?.shiftKey ||
				event?.altKey ||
				event?.metaKey ||
				event?.ctrlKey
			) {
				return false;
			}
			if (isTypeaheadSelectable()) return false;

			const rootEl = editor.getRootElement();
			if (!rootEl) return false;

			const { atFirstLine, atLastLine } = caretLinePosition(rootEl);
			if (direction === "up" && !atFirstLine) return false;
			if (direction === "down" && !atLastLine) return false;

			const history = getHistoryRef.current();
			if (history.length === 0) return false;

			const currentIndex = indexRef.current;

			if (direction === "up") {
				const nextIndex = Math.min(history.length - 1, currentIndex + 1);
				if (nextIndex === currentIndex) {
					// Already at the oldest entry — keep the focus where it
					// is. Returning true prevents the caret from drifting to
					// a previous DOM line as a side effect of the ArrowUp.
					event?.preventDefault();
					return true;
				}
				if (currentIndex < 0) {
					// First step into recall: snapshot whatever the user
					// had typed so a later Down past the newest entry can
					// restore it.
					const editorState = snapshotCurrentDraft();
					editor.read(() => {
						const content = $extractComposerContent();
						const empty =
							!content.text &&
							content.images.length === 0 &&
							content.files.length === 0 &&
							content.customTags.length === 0;
						pendingDraftRef.current = empty ? null : editorState;
						if (empty) {
							clearPersistedDraft(scopeKey);
						} else {
							savePersistedDraft(scopeKey, editorState);
						}
					});
				}
				indexRef.current = nextIndex;
				const entry = history[nextIndex];
				if (entry) applyEntry(entry);
				event?.preventDefault();
				return true;
			}

			// direction === "down"
			if (currentIndex < 0) {
				// Not in recall mode and Down at last line — let Lexical
				// run its default (no-op when already at last line).
				return false;
			}
			const nextIndex = currentIndex - 1;
			if (nextIndex >= 0) {
				indexRef.current = nextIndex;
				const entry = history[nextIndex];
				if (entry) applyEntry(entry);
				event?.preventDefault();
				return true;
			}
			// Stepping out: restore the saved in-progress draft.
			const draft = pendingDraftRef.current;
			pendingDraftRef.current = null;
			restoreDraft(draft);
			indexRef.current = -1;
			event?.preventDefault();
			return true;
		},
		[applyEntry, editor, restoreDraft, scopeKey, snapshotCurrentDraft],
	);

	useEffect(() => {
		return mergeRegister(
			editor.registerCommand(
				KEY_ARROW_UP_COMMAND,
				(event) => handleArrow("up", event),
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				KEY_ARROW_DOWN_COMMAND,
				(event) => handleArrow("down", event),
				COMMAND_PRIORITY_LOW,
			),
			editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves }) => {
				// Self-initiated updates (recall apply / draft restore) carry
				// our tag. Ignore those — only genuine user edits should
				// exit recall mode.
				if (tags.has(HISTORY_RECALL_TAG)) return;
				if (indexRef.current < 0) return;
				// Selection-only changes (caret movement) shouldn't exit
				// recall — only content mutations do.
				if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
				exitRecallMode();
			}),
		);
	}, [editor, exitRecallMode, handleArrow]);

	return null;
}
