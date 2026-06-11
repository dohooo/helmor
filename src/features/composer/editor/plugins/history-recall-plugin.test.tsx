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
	$createParagraphNode,
	$createRangeSelection,
	$createTextNode,
	$getRoot,
	$setSelection,
	createEditor,
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

function paragraphDraft(text: string): SerializedEditorState {
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
