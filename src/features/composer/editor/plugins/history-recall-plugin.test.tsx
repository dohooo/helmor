/**
 * Behavioural coverage for the ArrowUp/ArrowDown input-recall plugin.
 *
 * jsdom doesn't lay out content (every `getBoundingClientRect` returns
 * the zero rect), which conveniently puts the caret-line probe in its
 * "treat as both first AND last line" fallback — exactly the path we
 * want at the start of recall when the editor is empty or single-line.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import {
	$createLineBreakNode,
	$createParagraphNode,
	$createRangeSelection,
	$createTextNode,
	$getRoot,
	$isElementNode,
	$setSelection,
	createEditor,
	type LexicalEditor,
	type SerializedEditorState,
} from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModelSection } from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";
import {
	__resetDraftCacheForTests,
	loadPersistedDraft,
	savePersistedDraft,
} from "../../draft-storage";
import { WorkspaceComposer } from "../../index";
import type { InputHistoryEntry } from "../../input-history";
import { historyRecallTestUtils } from "./history-recall-plugin";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
	convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(),
}));

const MODEL_SECTIONS = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "opus-1m",
				provider: "claude",
				label: "Opus",
				cliModel: "opus-1m",
				effortLevels: ["low", "medium", "high"],
				supportsFastMode: true,
			},
		],
	},
] satisfies AgentModelSection[];

let testCounter = 0;

function textEntry(text: string): InputHistoryEntry {
	return { parts: [{ kind: "text", text }] };
}

function rect(top: number, bottom: number): DOMRect {
	return {
		top,
		bottom,
		left: 0,
		right: 100,
		width: 100,
		height: bottom - top,
		x: 0,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

function paragraphDraft(...lines: string[]): SerializedEditorState {
	return {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: null,
			children: lines.map((text) => ({
				type: "paragraph",
				version: 1,
				format: "",
				indent: 0,
				direction: null,
				textFormat: 0,
				textStyle: "",
				children: [
					{
						type: "text",
						version: 1,
						text,
						format: 0,
						mode: "normal",
						style: "",
						detail: 0,
					},
				],
			})),
		},
	} as unknown as SerializedEditorState;
}

/** ONE paragraph whose lines are separated by linebreak nodes — the shape
 *  Shift+Enter produces. An empty string yields a blank soft line. */
function softLineDraft(...lines: string[]): SerializedEditorState {
	const children: object[] = [];
	lines.forEach((text, i) => {
		if (i > 0) children.push({ type: "linebreak", version: 1 });
		if (text) {
			children.push({
				type: "text",
				version: 1,
				text,
				format: 0,
				mode: "normal",
				style: "",
				detail: 0,
			});
		}
	});
	return {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: null,
			children: [
				{
					type: "paragraph",
					version: 1,
					format: "",
					indent: 0,
					direction: null,
					textFormat: 0,
					textStyle: "",
					children,
				},
			],
		},
	} as unknown as SerializedEditorState;
}

function renderComposer(
	history: readonly InputHistoryEntry[],
	onSubmit = vi.fn(),
	contextKey?: string,
) {
	const queryClient = createHelmorQueryClient();
	testCounter += 1;
	const composerContextKey = contextKey ?? `session:recall-test-${testCounter}`;
	const result = render(
		<QueryClientProvider client={queryClient}>
			<WorkspaceComposer
				contextKey={composerContextKey}
				onSubmit={onSubmit}
				disabled={false}
				submitDisabled={false}
				sending={false}
				selectedModelId="opus-1m"
				modelSections={MODEL_SECTIONS}
				onSelectModel={vi.fn()}
				provider="claude"
				effortLevel="high"
				onSelectEffort={vi.fn()}
				permissionMode="bypassPermissions"
				onChangePermissionMode={vi.fn()}
				restoreImages={[]}
				restoreFiles={[]}
				restoreCustomTags={[]}
				getInputHistory={() => history}
			/>
		</QueryClientProvider>,
	);
	return { ...result, contextKey: composerContextKey, onSubmit };
}

beforeEach(() => {
	__resetDraftCacheForTests();
});

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	__resetDraftCacheForTests();
});

describe("HistoryRecallPlugin", () => {
	it("treats the last content line as last even when the editor is taller", () => {
		const root = document.createElement("div");
		const paragraph = document.createElement("p");
		const text = document.createTextNode("newest");
		paragraph.append(text);
		root.append(paragraph);
		document.body.append(root);
		const range = document.createRange();
		range.setStart(text, text.textContent?.length ?? 0);
		range.collapse(true);
		const rangeRect = vi.fn(() => rect(2, 18));
		Object.defineProperty(range, "getBoundingClientRect", {
			configurable: true,
			value: rangeRect,
		});

		const spies = [
			vi.spyOn(root, "getBoundingClientRect").mockReturnValue(rect(0, 100)),
			vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue(rect(0, 20)),
			vi.spyOn(range, "cloneRange").mockReturnValue(range),
			vi.spyOn(window, "getSelection").mockReturnValue({
				rangeCount: 1,
				getRangeAt: () => range,
			} as unknown as Selection),
		];

		try {
			expect(historyRecallTestUtils.caretLinePosition(root)).toEqual({
				atFirstLine: true,
				atLastLine: true,
			});
		} finally {
			for (const spy of spies) spy.mockRestore();
			root.remove();
		}
	});

	describe("$caretParagraphPosition", () => {
		function makeEditor() {
			const editor = createEditor({ namespace: "test" });
			const host = document.createElement("div");
			editor.setRootElement(host);
			return editor;
		}

		function readPosition(editor: ReturnType<typeof makeEditor>) {
			let result: { atFirstParagraph: boolean; atLastParagraph: boolean } = {
				atFirstParagraph: false,
				atLastParagraph: false,
			};
			editor.getEditorState().read(() => {
				result = historyRecallTestUtils.$caretParagraphPosition();
			});
			return result;
		}

		it("treats an empty editor as both first and last", () => {
			const editor = makeEditor();
			expect(readPosition(editor)).toEqual({
				atFirstParagraph: true,
				atLastParagraph: true,
			});
		});

		it("flags the middle paragraph as neither first nor last", () => {
			const editor = makeEditor();
			editor.update(
				() => {
					const root = $getRoot();
					root.clear();
					const p1 = $createParagraphNode().append($createTextNode("line 1"));
					const p2 = $createParagraphNode();
					const p3 = $createParagraphNode().append($createTextNode("line 3"));
					root.append(p1, p2, p3);
					const selection = $createRangeSelection();
					selection.anchor.set(p2.getKey(), 0, "element");
					selection.focus.set(p2.getKey(), 0, "element");
					$setSelection(selection);
				},
				{ discrete: true },
			);
			expect(readPosition(editor)).toEqual({
				atFirstParagraph: false,
				atLastParagraph: false,
			});
		});

		it("flags the first paragraph correctly", () => {
			const editor = makeEditor();
			editor.update(
				() => {
					const root = $getRoot();
					root.clear();
					const t1 = $createTextNode("first");
					const p1 = $createParagraphNode().append(t1);
					const p2 = $createParagraphNode().append($createTextNode("second"));
					root.append(p1, p2);
					const selection = $createRangeSelection();
					selection.anchor.set(t1.getKey(), 0, "text");
					selection.focus.set(t1.getKey(), 0, "text");
					$setSelection(selection);
				},
				{ discrete: true },
			);
			expect(readPosition(editor)).toEqual({
				atFirstParagraph: true,
				atLastParagraph: false,
			});
		});

		it("flags the last paragraph correctly", () => {
			const editor = makeEditor();
			editor.update(
				() => {
					const root = $getRoot();
					root.clear();
					const p1 = $createParagraphNode().append($createTextNode("first"));
					const t2 = $createTextNode("second");
					const p2 = $createParagraphNode().append(t2);
					root.append(p1, p2);
					const selection = $createRangeSelection();
					selection.anchor.set(t2.getKey(), t2.getTextContentSize(), "text");
					selection.focus.set(t2.getKey(), t2.getTextContentSize(), "text");
					$setSelection(selection);
				},
				{ discrete: true },
			);
			expect(readPosition(editor)).toEqual({
				atFirstParagraph: false,
				atLastParagraph: true,
			});
		});

		// Shift+Enter lines live as LineBreakNodes inside ONE paragraph, so
		// the first/last-child check alone can't see them.

		it("treats text after a soft line break as not the first line", () => {
			const editor = makeEditor();
			editor.update(
				() => {
					const root = $getRoot();
					root.clear();
					const t2 = $createTextNode("second");
					const p = $createParagraphNode();
					p.append($createTextNode("first"), $createLineBreakNode(), t2);
					root.append(p);
					const selection = $createRangeSelection();
					selection.anchor.set(t2.getKey(), 0, "text");
					selection.focus.set(t2.getKey(), 0, "text");
					$setSelection(selection);
				},
				{ discrete: true },
			);
			expect(readPosition(editor)).toEqual({
				atFirstParagraph: false,
				atLastParagraph: true,
			});
		});

		it("treats text before a soft line break as not the last line", () => {
			const editor = makeEditor();
			editor.update(
				() => {
					const root = $getRoot();
					root.clear();
					const t1 = $createTextNode("first");
					const p = $createParagraphNode();
					p.append(t1, $createLineBreakNode(), $createTextNode("second"));
					root.append(p);
					const selection = $createRangeSelection();
					selection.anchor.set(t1.getKey(), t1.getTextContentSize(), "text");
					selection.focus.set(t1.getKey(), t1.getTextContentSize(), "text");
					$setSelection(selection);
				},
				{ discrete: true },
			);
			expect(readPosition(editor)).toEqual({
				atFirstParagraph: true,
				atLastParagraph: false,
			});
		});

		it("treats an empty soft line between breaks as neither first nor last", () => {
			// Caret on a blank Shift+Enter line: element point on the paragraph,
			// offset between the two linebreak nodes.
			const editor = makeEditor();
			editor.update(
				() => {
					const root = $getRoot();
					root.clear();
					const p = $createParagraphNode();
					p.append(
						$createTextNode("top"),
						$createLineBreakNode(),
						$createLineBreakNode(),
						$createTextNode("bottom"),
					);
					root.append(p);
					const selection = $createRangeSelection();
					selection.anchor.set(p.getKey(), 2, "element");
					selection.focus.set(p.getKey(), 2, "element");
					$setSelection(selection);
				},
				{ discrete: true },
			);
			expect(readPosition(editor)).toEqual({
				atFirstParagraph: false,
				atLastParagraph: false,
			});
		});
	});

	it("does nothing when history is empty", async () => {
		renderComposer([]);
		const editor = screen.getByLabelText("Workspace input");
		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		// Empty editor should remain empty after a no-op recall press.
		expect(editor.textContent ?? "").toBe("");
	});

	it("walks back through history on successive ArrowUp presses", async () => {
		renderComposer([
			textEntry("newest"),
			textEntry("middle"),
			textEntry("oldest"),
		]);

		const editor = screen.getByLabelText("Workspace input");
		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(editor.textContent).toContain("newest"));

		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(editor.textContent).toContain("middle"));

		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(editor.textContent).toContain("oldest"));

		// Past the oldest entry the editor sticks.
		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(editor.textContent).toContain("oldest"));
	});

	it("ArrowDown from the newest entry restores the empty draft", async () => {
		renderComposer([textEntry("newest")]);
		const editor = screen.getByLabelText("Workspace input");

		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(editor.textContent).toContain("newest"));

		fireEvent.keyDown(editor, { key: "ArrowDown", code: "ArrowDown" });
		await waitFor(() => expect(editor.textContent ?? "").toBe(""));
	});

	it("yields to IME composition (isComposing/keyCode 229)", async () => {
		renderComposer([textEntry("should-not-recall")]);
		const editor = screen.getByLabelText("Workspace input");

		fireEvent.keyDown(editor, {
			key: "ArrowUp",
			code: "ArrowUp",
			keyCode: 229,
			isComposing: true,
		});
		// Plugin must not have applied the entry.
		expect(editor.textContent ?? "").toBe("");
	});

	it("yields to modifier-combined ArrowUp (e.g. Shift+ArrowUp for selection)", async () => {
		renderComposer([textEntry("should-not-recall")]);
		const editor = screen.getByLabelText("Workspace input");

		fireEvent.keyDown(editor, {
			key: "ArrowUp",
			code: "ArrowUp",
			shiftKey: true,
		});
		expect(editor.textContent ?? "").toBe("");
	});

	it("preserves mention order and submits recalled image paths once", async () => {
		const imagePath = "/Users/test/cache/paste/example.png";
		const filePath = "src/app.tsx";
		const onSubmit = vi.fn();
		renderComposer(
			[
				{
					parts: [
						{ kind: "text", text: "看 " },
						{ kind: "image", path: imagePath },
						{ kind: "text", text: " 然后改 " },
						{ kind: "file", path: filePath },
						{ kind: "text", text: "。" },
					],
				},
			],
			onSubmit,
		);
		const editor = screen.getByLabelText("Workspace input");

		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(editor.textContent).toContain("然后改"));
		fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });

		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		const [prompt, images, files] = onSubmit.mock.calls[0];
		expect(prompt).toBe(`看 @${imagePath} 然后改 @${filePath}。`);
		expect(prompt.split(imagePath)).toHaveLength(2);
		expect(images).toEqual([imagePath]);
		expect(files).toEqual([filePath]);
	});

	it("does not persist the recalled history entry over the saved draft", async () => {
		const contextKey = "session:recall-draft";
		savePersistedDraft(contextKey, paragraphDraft("keep this draft"));
		const { unmount } = renderComposer(
			[textEntry("history prompt")],
			vi.fn(),
			contextKey,
		);
		const editor = screen.getByLabelText("Workspace input");

		await waitFor(() =>
			expect(editor.textContent).toContain("keep this draft"),
		);
		fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(editor.textContent).toContain("history prompt"));
		unmount();

		const persisted = JSON.stringify(loadPersistedDraft(contextKey));
		expect(persisted).toContain("keep this draft");
		expect(persisted).not.toContain("history prompt");
	});

	it("keeps the caret at the end of a multi-line draft restored via ArrowDown", async () => {
		// Regression: returning to a multi-line in-progress draft must leave the
		// caret at the end of the LAST paragraph. If the selection is lost (or
		// lands on the first paragraph), the next ArrowUp re-enters recall
		// instead of moving the caret within the draft.
		const contextKey = "session:recall-multiline";
		savePersistedDraft(contextKey, paragraphDraft("first line", "second line"));
		renderComposer([textEntry("history prompt")], vi.fn(), contextKey);
		const editorEl = screen.getByLabelText("Workspace input");
		await waitFor(() => expect(editorEl.textContent).toContain("second line"));

		const editor = (editorEl as unknown as { __lexicalEditor: LexicalEditor })
			.__lexicalEditor;
		expect(editor).toBeTruthy();

		// Caret on the first paragraph so ArrowUp enters recall.
		editor.update(
			() => {
				const first = $getRoot().getFirstChild();
				if ($isElementNode(first)) first.selectStart();
			},
			{ discrete: true },
		);

		fireEvent.keyDown(editorEl, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() =>
			expect(editorEl.textContent).toContain("history prompt"),
		);

		fireEvent.keyDown(editorEl, { key: "ArrowDown", code: "ArrowDown" });
		await waitFor(() => expect(editorEl.textContent).toContain("second line"));

		// Caret must be at the end of the restored draft (last paragraph).
		let pos: { atFirstParagraph: boolean; atLastParagraph: boolean } | null =
			null;
		editor.getEditorState().read(() => {
			pos = historyRecallTestUtils.$caretParagraphPosition();
		});
		expect(pos).toEqual({ atFirstParagraph: false, atLastParagraph: true });

		// ArrowUp from the last paragraph must move the caret, not recall.
		fireEvent.keyDown(editorEl, { key: "ArrowUp", code: "ArrowUp" });
		expect(editorEl.textContent).toContain("second line");
		expect(editorEl.textContent).not.toContain("history prompt");
	});

	it("does not recall from a blank Shift+Enter line with text above it", async () => {
		// Shift+Enter lines live in ONE paragraph as LineBreakNodes. With the
		// caret on a blank soft line (between two breaks) the collapsed DOM
		// range has no rect, so only the Lexical-side check can tell there is
		// still a line above — ArrowUp must move the caret, not recall.
		const contextKey = "session:recall-softline";
		savePersistedDraft(contextKey, softLineDraft("top", "", "bottom"));
		renderComposer([textEntry("history prompt")], vi.fn(), contextKey);
		const editorEl = screen.getByLabelText("Workspace input");
		await waitFor(() => expect(editorEl.textContent).toContain("bottom"));

		const editor = (editorEl as unknown as { __lexicalEditor: LexicalEditor })
			.__lexicalEditor;
		// `editor.read` flushes pending updates first — DOM textContent can lag
		// a recall applied inside the keydown dispatch.
		const committedText = () => editor.read(() => $getRoot().getTextContent());

		// Caret at the end of the last soft line: ArrowUp must NOT recall.
		editor.update(
			() => {
				$getRoot().selectEnd();
			},
			{ discrete: true },
		);
		fireEvent.keyDown(editorEl, { key: "ArrowUp", code: "ArrowUp" });
		expect(committedText()).not.toContain("history prompt");

		// Caret on the blank middle soft line (element point between breaks).
		editor.update(
			() => {
				const first = $getRoot().getFirstChild();
				if (!$isElementNode(first)) return;
				const selection = $createRangeSelection();
				selection.anchor.set(first.getKey(), 2, "element");
				selection.focus.set(first.getKey(), 2, "element");
				$setSelection(selection);
			},
			{ discrete: true },
		);
		fireEvent.keyDown(editorEl, { key: "ArrowUp", code: "ArrowUp" });
		expect(committedText()).not.toContain("history prompt");

		// Caret at the very start (first soft line): ArrowUp SHOULD recall.
		editor.update(
			() => {
				const first = $getRoot().getFirstChild();
				if ($isElementNode(first)) first.selectStart();
			},
			{ discrete: true },
		);
		fireEvent.keyDown(editorEl, { key: "ArrowUp", code: "ArrowUp" });
		await waitFor(() => expect(committedText()).toContain("history prompt"));
	});

	it("refocuses the editor when ArrowDown restores a non-empty draft", async () => {
		// Regression: `setEditorState` clears the DOM selection, blurring the
		// contentEditable in WebKit. Restoring the draft must refocus the editor
		// so the caret stays visible. jsdom can't reproduce the blur, so assert
		// the explicit refocus call instead.
		const focusSpy = vi.spyOn(
			Object.getPrototypeOf(createEditor()) as { focus: () => void },
			"focus",
		);
		try {
			const contextKey = "session:recall-refocus";
			savePersistedDraft(contextKey, paragraphDraft("my draft"));
			renderComposer([textEntry("history prompt")], vi.fn(), contextKey);
			const editor = screen.getByLabelText("Workspace input");

			await waitFor(() => expect(editor.textContent).toContain("my draft"));
			fireEvent.keyDown(editor, { key: "ArrowUp", code: "ArrowUp" });
			await waitFor(() =>
				expect(editor.textContent).toContain("history prompt"),
			);

			focusSpy.mockClear();
			fireEvent.keyDown(editor, { key: "ArrowDown", code: "ArrowDown" });
			await waitFor(() => expect(editor.textContent).toContain("my draft"));
			expect(focusSpy).toHaveBeenCalled();
		} finally {
			focusSpy.mockRestore();
		}
	});
});
