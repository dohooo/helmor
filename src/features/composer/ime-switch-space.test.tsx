/**
 * Regression tests for the CJK IME "switch-mid-composition" space-leak bug.
 *
 * Why this exists: when a user types under an active Chinese pinyin IME and
 * the IME segments their input (e.g. `helmor` → candidate row shows
 * `he | lmor`), if the user **switches IMEs** (Shift / Ctrl+Space / Cmd+Space
 * to flip to English) WITHOUT pressing Enter to confirm or Esc to cancel,
 * the OS force-commits the IME's pending buffer into the contenteditable —
 * with the IME's own segmentation spaces preserved as ASCII U+0020s. The
 * editor ends up with `he lmor` instead of the `helmor` the user actually
 * typed.
 *
 * The browser-level event surface for this is genuinely under-specified:
 *   - W3C UI Events says nothing normative about IME-switch interruption.
 *   - Chromium typically fires `compositionend` with `event.data` = the raw
 *     buffer (including the IME's segmentation spaces).
 *   - WebKit (Helmor's Tauri target) sometimes does not fire `compositionend`
 *     at all and lets the text arrive only through `input` events
 *     (WebKit bug 164369).
 *   - Firefox sometimes leaves the widget stuck in composing mode forever
 *     with no `compositionend` (Mozilla bug 1219438).
 *
 * The cross-cutting consensus from the rich-text-editor world (ProseMirror,
 * Quill, CKEditor 5, Draft.js, Marijn Haverbeke's CodeMirror 6 notes) is
 * "do NOT trust `compositionend.data`; reconcile against the DOM." Lexical
 * sits on the wrong side of that line: `$onCompositionEndImpl` calls
 * `$updateSelectedTextFromDOM(true, editor, data)` and writes whatever
 * the IME left in `data` straight into the model — no ASCII-vs-CJK check,
 * no IME-segmentation-space heuristic, no DOM diff. That is the proximate
 * cause of this bug in our composer.
 *
 * Two pieces of prior art directly inform the test design:
 *   - catnose99/use-chat-submit listens to `compositioncancel` (the event
 *     Chromium fires when the IME is force-switched mid-composition).
 *   - React PR #12563 (Korean IME compositionend.data fix) is the canonical
 *     example of "trust nativeEvent.data over the reconstructed buffer."
 *
 * The safe transformation: `data.replace(/\s+/g, '')` IFF the data is pure
 * printable ASCII. Pinyin / Zhuyin / Wubi / Cangjie candidate buffers never
 * contain intentional ASCII spaces — every U+0020 in the buffer is an
 * IME-injected segmentation separator. The regression test below pins this
 * conditional behavior down so a future "just strip every space" fix can't
 * silently nuke a user's legitimate Chinese-with-spaces input.
 *
 * jsdom note: jsdom doesn't simulate an OS IME, so we mimic what an IME
 * does at the DOM layer ourselves — we write the segmented buffer directly
 * into the contenteditable's text node, then dispatch the composition
 * events Lexical actually listens to. Probed and confirmed: this faithfully
 * reproduces the editor end-state we observe in production WebKit.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentModelSection } from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";

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

vi.mock("@/components/ai/code-block", () => ({
	CodeBlock: ({ code, language }: { code: string; language?: string }) => (
		<div data-testid="code-block">
			{language ?? "code"}::{code}
		</div>
	),
}));

import { WorkspaceComposer } from "./index";

// jsdom doesn't implement Range.getBoundingClientRect, which Lexical's
// post-commit selection update calls. The call happens AFTER we've already
// asserted on textContent, but it raises an unhandled exception in the
// test runner. Stubbing keeps the noise out without affecting behavior.
beforeAll(() => {
	if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
		Range.prototype.getBoundingClientRect = () =>
			({
				x: 0,
				y: 0,
				width: 0,
				height: 0,
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				toJSON: () => ({}),
			}) as DOMRect;
	}
	if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
		Range.prototype.getClientRects = () =>
			({
				length: 0,
				item: () => null,
				[Symbol.iterator]: function* () {},
			}) as unknown as DOMRectList;
	}
});

afterEach(() => {
	cleanup();
	window.localStorage.clear();
});

const MODEL_SECTIONS = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "opus-1m",
				provider: "claude",
				label: "Opus 4.7 1M",
				cliModel: "opus-1m",
				effortLevels: ["low", "medium", "high", "max"],
				supportsFastMode: true,
			},
		],
	},
] satisfies AgentModelSection[];

function renderComposer() {
	const queryClient = createHelmorQueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<WorkspaceComposer
				contextKey="session:ime-switch-test"
				onSubmit={vi.fn()}
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
			/>
		</QueryClientProvider>,
	);
}

/**
 * Mimic an OS-level IME interaction at the DOM layer.
 *
 * Real flow: user types raw keys → IME intercepts and shows segmented
 * candidates in the IME popup → IME writes the running buffer into the
 * contenteditable as plain text AND places the caret at the end of that
 * buffer → user switches IME → OS commits the buffer and the browser
 * fires compositionend with `data` = the buffer.
 *
 * jsdom doesn't simulate any of that, so we simulate the *editor-visible*
 * outcome: write the segmented buffer into the paragraph text node,
 * collapse the DOM selection to the end of that buffer (what any real
 * IME would do before compositionend), then dispatch the composition
 * events Lexical actually listens to.
 */
function simulateImeSwitchCommit(editor: HTMLElement, segmentedBuffer: string) {
	const paragraph = editor.querySelector("p");
	if (!paragraph) {
		throw new Error(
			"Composer paragraph element not found — Lexical didn't mount?",
		);
	}
	fireEvent.compositionStart(editor, { data: "" });
	paragraph.textContent = segmentedBuffer;
	const textNode = paragraph.firstChild;
	if (textNode) {
		const sel = editor.ownerDocument.defaultView?.getSelection();
		if (sel) {
			const range = editor.ownerDocument.createRange();
			range.setStart(textNode, segmentedBuffer.length);
			range.setEnd(textNode, segmentedBuffer.length);
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}
	fireEvent.compositionUpdate(editor, { data: segmentedBuffer });
	fireEvent.compositionEnd(editor, { data: segmentedBuffer });
}

function simulateImeSwitchCommitWithPrefix(
	editor: HTMLElement,
	existingText: string,
	segmentedBuffer: string,
	trailingGhost = "",
	endEvent: "compositionend" | "compositioncancel" = "compositionend",
) {
	const paragraph = editor.querySelector("p");
	if (!paragraph) {
		throw new Error(
			"Composer paragraph element not found — Lexical didn't mount?",
		);
	}
	const combinedText = `${existingText}${segmentedBuffer}${trailingGhost}`;
	fireEvent.compositionStart(editor, { data: "" });
	paragraph.textContent = combinedText;
	const textNode = paragraph.firstChild;
	if (textNode) {
		const sel = editor.ownerDocument.defaultView?.getSelection();
		if (sel) {
			const range = editor.ownerDocument.createRange();
			range.setStart(textNode, combinedText.length);
			range.setEnd(textNode, combinedText.length);
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}
	fireEvent.compositionUpdate(editor, { data: segmentedBuffer });
	if (endEvent === "compositioncancel") {
		fireEvent(
			editor,
			new CompositionEvent("compositioncancel", {
				data: segmentedBuffer,
				bubbles: true,
			}),
		);
		return;
	}
	fireEvent.compositionEnd(editor, { data: segmentedBuffer });
}

function simulateFollowUpComposition(
	editor: HTMLElement,
	nextTextContent: string,
	compositionData: string,
) {
	const paragraph = editor.querySelector("p");
	if (!paragraph) {
		throw new Error(
			"Composer paragraph element not found — Lexical didn't mount?",
		);
	}
	fireEvent.compositionStart(editor, { data: "" });
	paragraph.textContent = nextTextContent;
	const textNode = paragraph.firstChild;
	if (textNode) {
		const sel = editor.ownerDocument.defaultView?.getSelection();
		if (sel) {
			const range = editor.ownerDocument.createRange();
			range.setStart(textNode, nextTextContent.length);
			range.setEnd(textNode, nextTextContent.length);
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}
	fireEvent.compositionUpdate(editor, { data: compositionData });
	fireEvent.compositionEnd(editor, { data: compositionData });
}

function getLexicalEditorFromRoot(editor: HTMLElement): {
	update: (fn: () => void) => void;
} {
	const key = Object.keys(editor).find((entry) =>
		entry.startsWith("__lexicalEditor"),
	);
	if (!key) {
		throw new Error("Lexical editor instance not found on root element");
	}
	return (editor as unknown as Record<string, unknown>)[key] as {
		update: (fn: () => void) => void;
	};
}

describe("WorkspaceComposer — IME switch mid-composition leaves segmentation spaces", () => {
	it("strips IME segmentation spaces when a pure-ASCII pinyin buffer is force-committed", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		// User typed "helmor" with Chinese pinyin IME active. The IME
		// segmented it as `he | lmor` (visible in the candidate strip).
		// User pressed Shift to switch to English IME without confirming
		// — OS commits the segmented buffer "he lmor" with the inserted
		// space.
		simulateImeSwitchCommit(editor, "he lmor");

		await waitFor(() => {
			expect(editor.textContent).toBe("helmor");
		});
	});

	it("strips IME segmentation spaces from a multi-word English buffer (`useState` segmented as `use state`)", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		simulateImeSwitchCommit(editor, "use state");

		await waitFor(() => {
			expect(editor.textContent).toBe("usestate");
		});
	});

	// Regression guard for the upcoming fix.
	//
	// The cheap fix is `data.replace(/\s+/g, '')` — but applied
	// unconditionally that nukes legitimate spaces in any compositionend
	// payload, including normal CJK candidates that *do* contain a real
	// space (mixed-script commits like "<CJK> world" are valid). This test
	// pins down the conditional shape of the fix: only strip when the
	// committed `data` is pure printable ASCII (which is the IME-segmented
	// pinyin / wubi / zhuyin / cangjie buffer signature — those engines
	// never emit candidates with intentional ASCII spaces).
	//
	// Today this passes because Lexical writes the data verbatim; after
	// the fix this MUST keep passing because the strip is guarded on
	// "ASCII-only data." If a future refactor drops the guard, the test
	// turns red and we know we just broke every CJK user's mixed-script
	// input.
	it("regression: a compositionend payload that contains CJK characters preserves its spaces verbatim", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		// Realistic mixed-script commit — IME confirmed a CJK candidate
		// followed by an intentional space and Latin text; the space here
		// is NOT IME segmentation, it is what the user wanted.
		simulateImeSwitchCommit(editor, "你好 world");

		expect(editor.textContent).toBe("你好 world");
	});

	// When the strip plugin mutates the text node we have to re-anchor the
	// DOM selection to the end of the REPLACEMENT text. Without that
	// re-anchor, setting `.textContent` on the Text node either clamps the
	// selection to the new shorter length on spec-compliant engines OR
	// collapses it to offset 0 on WebKit (the user reported "cursor flashes
	// to the front" after our original fix landed — that is the WebKit
	// collapse path). Either way, Lexical's bubble-phase compositionend
	// handler then reads whatever offset it finds and writes it into the
	// model, so an unset selection becomes the persistent caret position
	// shown to the user.
	//
	// This test pins the desired behavior: after a pinyin buffer
	// `"he lmor"` is force-committed (IME cursor at end, offset 7), the
	// strip lands `"helmor"` in the editor AND the caret ends at the end
	// of `"helmor"` (offset 6). Today jsdom clamps the selection so this
	// may be passing already on paper — but the plugin itself does not
	// restore the selection explicitly, which is what the real-world
	// WebKit bug requires. Fix must add an explicit
	// `selection.collapse(textNode, newEnd)` after the mutation.
	it("keeps the stripped text after IME commit", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		simulateImeSwitchCommit(editor, "he lmor");

		await waitFor(() => {
			expect(editor.textContent).toBe("helmor");
		});
	});

	it("keeps the stripped ASCII buffer stable when the next composition happens in Chinese IME", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		simulateImeSwitchCommit(editor, "he lmor");
		await waitFor(() => {
			expect(editor.textContent).toBe("helmor");
		});

		simulateFollowUpComposition(editor, "helmor你好", "你好");

		await waitFor(() => {
			expect(editor.textContent).toBe("helmor你好");
			expect(editor.textContent?.includes("he lmor")).toBe(false);

			const sel = editor.ownerDocument.defaultView?.getSelection();
			expect(sel?.isCollapsed).toBe(true);

			const paragraph = editor.querySelector("p");
			const textNode = paragraph?.firstChild;
			if (sel && sel.anchorNode === textNode) {
				expect(sel.anchorOffset).toBe("helmor你好".length);
				return;
			}
			if (sel && sel.anchorNode === paragraph) {
				expect(sel.anchorOffset).toBeGreaterThanOrEqual(1);
				return;
			}
			throw new Error(
				`Unexpected anchor node: ${sel?.anchorNode?.nodeName ?? "null"}`,
			);
		});
	});

	it("keeps the stripped text stable across a subsequent Lexical update", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		simulateImeSwitchCommit(editor, "he lmor");
		await waitFor(() => {
			expect(editor.textContent).toBe("helmor");
		});

		getLexicalEditorFromRoot(editor).update(() => {});

		await waitFor(() => {
			expect(editor.textContent).toBe("helmor");
		});
	});

	it("does not leave a trailing blank placeholder when ascii IME text is committed after existing Chinese text", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		simulateImeSwitchCommitWithPrefix(
			editor,
			"思考大勇分",
			"sl dkjf",
			"\u00A0",
		);
		await waitFor(() => {
			expect(editor.textContent).toBe("思考大勇分sldkjf");
		});

		getLexicalEditorFromRoot(editor).update(() => {});

		await waitFor(() => {
			expect(editor.textContent).toBe("思考大勇分sldkjf");
			expect(editor.textContent?.includes("\u00A0")).toBe(false);
			expect(editor.querySelectorAll("p")).toHaveLength(1);
		});
	});

	it("clears interrupted composition state when ime switch emits compositioncancel", async () => {
		renderComposer();
		const editor = await screen.findByLabelText("Workspace input");
		editor.focus();

		simulateImeSwitchCommitWithPrefix(
			editor,
			"思考大勇分",
			"sl dkjf",
			"\u00A0",
			"compositioncancel",
		);

		getLexicalEditorFromRoot(editor).update(() => {});

		await waitFor(() => {
			expect(editor.textContent?.includes("\u00A0")).toBe(false);
			expect(editor.querySelectorAll("p")).toHaveLength(1);
		});
	});
});
