/**
 * Caret-placement policy for passive draft restores.
 *
 * A passive restore (selecting another workspace/session, which changes
 * `contextKey`) must NOT steal focus on touch devices — writing a DOM
 * selection into the contenteditable focuses it and pops the on-screen
 * keyboard. We can't observe that focus side-effect in jsdom (it doesn't
 * implement `Selection.setBaseAndExtent`'s focus behaviour), so instead we
 * assert the thing we actually control: whether a selection is written at all.
 */

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
	$getRoot,
	$getSelection,
	$isRangeSelection,
	type LexicalEditor,
} from "lexical";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDraftCacheForTests } from "@/features/composer/draft-storage";
import { DraftPersistencePlugin } from "./draft-persistence-plugin";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === "list_session_drafts") return [];
		if (cmd === "set_session_draft") return undefined;
		return undefined;
	}),
	convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
}));

function renderDraftPlugin(props: {
	contextKey: string;
	restoreDraft: string;
	focusOnRestore?: boolean;
}): LexicalEditor {
	const editorRef = createRef<LexicalEditor>();
	render(
		<LexicalComposer
			initialConfig={{
				namespace: "draft-persistence-test",
				onError: (error: Error) => {
					throw error;
				},
				nodes: [],
			}}
		>
			<PlainTextPlugin
				contentEditable={<ContentEditable />}
				placeholder={null}
				ErrorBoundary={LexicalErrorBoundary}
			/>
			<DraftPersistencePlugin
				contextKey={props.contextKey}
				restoreDraft={props.restoreDraft}
				restoreImages={[]}
				restoreFiles={[]}
				restoreCustomTags={[]}
				focusOnRestore={props.focusOnRestore}
			/>
			<EditorRefPlugin editorRef={editorRef} />
		</LexicalComposer>,
	);
	const editor = editorRef.current;
	if (!editor) throw new Error("editor ref was not assigned");
	return editor;
}

describe("DraftPersistencePlugin passive-restore caret placement", () => {
	beforeEach(() => {
		__resetDraftCacheForTests();
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("places the caret at the end of the restored draft by default (desktop)", async () => {
		const editor = renderDraftPlugin({
			contextKey: "session:desktop",
			restoreDraft: "hello world",
			focusOnRestore: true,
		});

		await waitFor(() => {
			editor.getEditorState().read(() => {
				expect($getRoot().getTextContent()).toBe("hello world");
			});
		});

		editor.getEditorState().read(() => {
			const selection = $getSelection();
			expect($isRangeSelection(selection)).toBe(true);
			if ($isRangeSelection(selection)) {
				expect(selection.isCollapsed()).toBe(true);
			}
		});
	});

	it("restores draft content without writing a selection on mobile", async () => {
		const editor = renderDraftPlugin({
			contextKey: "session:mobile",
			restoreDraft: "hello world",
			focusOnRestore: false,
		});

		// The draft content is still restored…
		await waitFor(() => {
			editor.getEditorState().read(() => {
				expect($getRoot().getTextContent()).toBe("hello world");
			});
		});

		// …but no selection is written, so the contenteditable never grabs focus —
		// which on touch devices is what pops the on-screen keyboard.
		editor.getEditorState().read(() => {
			expect($getSelection()).toBeNull();
		});
	});
});
