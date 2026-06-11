/**
 * Shell-style input recall: ArrowUp/ArrowDown at the editor's first /
 * last line walks back/forward through previously submitted prompts.
 *
 * Boundary check is hybrid: Lexical position (anchor's top-level
 * paragraph must equal root's first/last child, with no Shift+Enter
 * LineBreakNode before/after the caret inside it) AND DOM visual-line
 * position. Lexical guards blank middle paragraphs and soft line
 * breaks; DOM handles visual soft-wrap.
 *
 * Past the oldest/newest entry stays put; Down past newest restores the
 * in-progress draft snapshotted on first Up. Editing a recalled entry
 * exits recall and adopts the recalled+edited text as the new draft.
 *
 * Guards: yields Arrow keys to active typeahead popups and IME
 * composition (same as `SubmitPlugin`).
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
	$getRoot,
	$getSelection,
	$isElementNode,
	$isLineBreakNode,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	type LexicalNode,
	type SerializedEditorState,
} from "lexical";
import { useCallback, useEffect, useRef } from "react";
import { clearPersistedDraft, savePersistedDraft } from "../../draft-storage";
import { $setEditorContent, $setEditorContentParts } from "../../editor-ops";
import type { InputHistoryEntry } from "../../input-history";
import { $extractComposerContent } from "../utils";

/** Tags on recall-plugin edits; `DraftPersistencePlugin` watches these
 *  to avoid persisting recalled prompts over the in-progress draft. */
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
	// Fallback `{true, true}` covers jsdom (no layout) and empty-editor;
	// harmless in production single-line case.
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

/** Lexical-side first/last line check; `{true, true}` when no range
 *  selection so the DOM line check still decides. Shift+Enter lines live
 *  as LineBreakNodes inside ONE paragraph, so being in the first/last
 *  top-level paragraph is not enough — the caret must also have no soft
 *  line break before/after it within that paragraph. */
function $caretParagraphPosition(): {
	atFirstParagraph: boolean;
	atLastParagraph: boolean;
} {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) {
		return { atFirstParagraph: true, atLastParagraph: true };
	}
	const root = $getRoot();
	const firstChild = root.getFirstChild();
	const lastChild = root.getLastChild();
	if (!firstChild || !lastChild) {
		return { atFirstParagraph: true, atLastParagraph: true };
	}
	let node = selection.anchor.getNode();
	// Direct child of the top-level node that contains the caret; null when
	// the anchor is an element point on the top-level node itself.
	let caretChild: LexicalNode | null = null;
	let parent = node.getParent();
	while (parent && parent.getKey() !== root.getKey()) {
		caretChild = node;
		node = parent;
		parent = node.getParent();
	}
	if (!parent) {
		return { atFirstParagraph: true, atLastParagraph: true };
	}
	let breakBefore = false;
	let breakAfter = false;
	if ($isElementNode(node)) {
		const children = node.getChildren();
		// Element-point offsets already count the children before the caret;
		// for an inline child, breaks strictly before/after it decide.
		const index = caretChild
			? caretChild.getIndexWithinParent()
			: selection.anchor.offset;
		breakBefore = children.slice(0, index).some($isLineBreakNode);
		breakAfter = children
			.slice(caretChild ? index + 1 : index)
			.some($isLineBreakNode);
	}
	const key = node.getKey();
	return {
		atFirstParagraph: firstChild.getKey() === key && !breakBefore,
		atLastParagraph: lastChild.getKey() === key && !breakAfter,
	};
}

export const historyRecallTestUtils = {
	caretLinePosition,
	$caretParagraphPosition,
};

type Props = {
	/** Per-session recall list, most-recent first. Called lazily on each
	 *  Arrow press so cache updates don't re-render the plugin. */
	getHistory: () => readonly InputHistoryEntry[];
	/** Resets recall state on session swap. */
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
					// Bake the caret into the parsed state itself. We're inside a
					// command listener (editor mid-update), where `setEditorState`
					// stashes the new state as pending WITHOUT committing — a
					// follow-up `editor.update(selectEnd)` would run against the
					// stale previous state, so the restored draft would commit
					// with a null selection (caret lost on multi-line drafts).
					const parsed = editor.parseEditorState(serialized, () => {
						$getRoot().selectEnd();
					});
					editor.setEditorState(parsed, { tag: HISTORY_RECALL_RESTORE_TAG });
					// `setEditorState` wipes the DOM selection (removeAllRanges),
					// which blurs the contentEditable in WebKit. The model selection
					// alone doesn't refocus it, so the caret stays invisible —
					// refocus now that the selection is committed.
					editor.focus(undefined, { defaultSelection: "rootEnd" });
					return;
				} catch {
					// Fall through to empty restore.
				}
			}
			editor.update(
				() => {
					$setEditorContent("", [], [], []);
					// Re-place the caret — rebuilding the root drops the selection,
					// which leaves the composer with no visible cursor.
					$getRoot().selectEnd();
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

			// Both Lexical paragraph and DOM visual line must agree before
			// we eat the keystroke.
			let atFirstParagraph = false;
			let atLastParagraph = false;
			editor.getEditorState().read(() => {
				const pos = $caretParagraphPosition();
				atFirstParagraph = pos.atFirstParagraph;
				atLastParagraph = pos.atLastParagraph;
			});
			const { atFirstLine, atLastLine } = caretLinePosition(rootEl);
			if (direction === "up" && !(atFirstParagraph && atFirstLine)) {
				return false;
			}
			if (direction === "down" && !(atLastParagraph && atLastLine)) {
				return false;
			}

			const history = getHistoryRef.current();
			if (history.length === 0) return false;

			const currentIndex = indexRef.current;

			if (direction === "up") {
				const nextIndex = Math.min(history.length - 1, currentIndex + 1);
				if (nextIndex === currentIndex) {
					// At oldest entry — preventDefault so the caret doesn't drift.
					event?.preventDefault();
					return true;
				}
				if (currentIndex < 0) {
					// First step into recall: snapshot the current draft so a
					// later Down past newest can restore it.
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
				// Not in recall: let Lexical handle the default.
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
				// Ignore self-tagged updates and caret-only changes — only
				// real user edits exit recall.
				if (tags.has(HISTORY_RECALL_TAG)) return;
				if (indexRef.current < 0) return;
				if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
				exitRecallMode();
			}),
		);
	}, [editor, exitRecallMode, handleArrow]);

	return null;
}
