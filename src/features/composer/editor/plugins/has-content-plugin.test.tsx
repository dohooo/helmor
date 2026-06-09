/**
 * Behavioural coverage for HasContentPlugin.
 *
 * The plugin gained a dirty-elements/dirty-leaves guard (skip selection-only
 * updates) as a perf optimization. These tests lock the ZERO-functional-change
 * property: the emitted boolean must be identical to the un-gated version —
 * content edits still notify, and a selection-only update never flips (or
 * re-emits) the value.
 *
 * Updates use `{ discrete: true }` so Lexical flushes the reconcile + update
 * listeners synchronously (this composer harness has no ContentEditable / root
 * element, so the default async update cycle would never run the listener).
 */

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { LexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { act, cleanup, render } from "@testing-library/react";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type LexicalEditor,
} from "lexical";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomTagBadgeNode } from "../custom-tag-badge-node";
import { FileBadgeNode } from "../file-badge-node";
import { $createImageBadgeNode, ImageBadgeNode } from "../image-badge-node";
import { HasContentPlugin } from "./has-content-plugin";

afterEach(() => {
	cleanup();
});

/** Grabs the live editor instance out of the composer context so the test can
 * drive `editor.update()` directly. */
function CaptureEditor({ onReady }: { onReady: (e: LexicalEditor) => void }) {
	const ctx = useContext(LexicalComposerContext);
	if (ctx) {
		onReady(ctx[0]);
	}
	return null;
}

function renderPlugin(onChange: (hasContent: boolean) => void) {
	let editor!: LexicalEditor;
	render(
		<LexicalComposer
			initialConfig={{
				namespace: "has-content-test",
				onError: (error) => {
					throw error;
				},
				nodes: [ImageBadgeNode, FileBadgeNode, CustomTagBadgeNode],
			}}
		>
			<HasContentPlugin onChange={onChange} />
			<CaptureEditor
				onReady={(e) => {
					editor = e;
				}}
			/>
		</LexicalComposer>,
	);
	return editor;
}

describe("HasContentPlugin", () => {
	it("reports true once text content is inserted", () => {
		const onChange = vi.fn();
		const editor = renderPlugin(onChange);

		act(() => {
			editor.update(
				() => {
					const paragraph = $createParagraphNode();
					paragraph.append($createTextNode("hello"));
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});

		// Content edit dirties a leaf → the guard passes and we notify true.
		expect(onChange).toHaveBeenLastCalledWith(true);
	});

	it("reports false again after the content is cleared", () => {
		const onChange = vi.fn();
		const editor = renderPlugin(onChange);

		act(() => {
			editor.update(
				() => {
					const paragraph = $createParagraphNode();
					paragraph.append($createTextNode("draft"));
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});
		expect(onChange).toHaveBeenLastCalledWith(true);

		act(() => {
			editor.update(
				() => {
					$getRoot().clear();
				},
				{ discrete: true },
			);
		});
		expect(onChange).toHaveBeenLastCalledWith(false);
	});

	it("re-evaluates on every content edit (gate lets real changes through)", () => {
		// The dirty-gate only skips updates that dirty NO element and NO leaf
		// (selection-only). Every text mutation dirties a leaf, so the boolean
		// must stay in lock-step with content across an edit sequence — this is
		// the property the optimization must not break.
		const onChange = vi.fn();
		const editor = renderPlugin(onChange);

		act(() => {
			editor.update(
				() => {
					const paragraph = $createParagraphNode();
					paragraph.append($createTextNode("first"));
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});
		expect(onChange).toHaveBeenLastCalledWith(true);

		// Replace the text with whitespace-only content: `$hasContent` trims, so
		// the result is empty. The edit dirties a leaf, so the gate passes and
		// the boolean must drop to false.
		act(() => {
			editor.update(
				() => {
					$getRoot().clear();
					const paragraph = $createParagraphNode();
					paragraph.append($createTextNode("   "));
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});
		expect(onChange).toHaveBeenLastCalledWith(false);

		// Type real text again → back to true.
		act(() => {
			editor.update(
				() => {
					$getRoot().clear();
					const paragraph = $createParagraphNode();
					paragraph.append($createTextNode("second"));
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});
		expect(onChange).toHaveBeenLastCalledWith(true);
	});

	it("treats a badge node as content even with no text", () => {
		// $hasContent() returns true for image/file/customTag badge nodes. This
		// locks that the gate (which fires when an element is dirtied by the
		// badge insert) still surfaces badge-only content as true.
		const onChange = vi.fn();
		const editor = renderPlugin(onChange);

		act(() => {
			editor.update(
				() => {
					const paragraph = $createParagraphNode();
					paragraph.append($createImageBadgeNode("/tmp/pic.png"));
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});

		expect(onChange).toHaveBeenLastCalledWith(true);
	});
});
