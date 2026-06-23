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
import { $createFileBadgeNode, FileBadgeNode } from "../file-badge-node";
import { ImageBadgeNode } from "../image-badge-node";
import {
	$createTerminalDirectiveNode,
	TerminalDirectiveNode,
} from "../terminal-directive-node";
import { TerminalDirectivePlugin } from "./terminal-directive-plugin";

afterEach(() => {
	cleanup();
});

function CaptureEditor({
	onReady,
}: {
	onReady: (editor: LexicalEditor) => void;
}) {
	const ctx = useContext(LexicalComposerContext);
	if (ctx) onReady(ctx[0]);
	return null;
}

function renderPlugin(
	onDirectiveChange: (state: { active: boolean; emptyAfter: boolean }) => void,
) {
	let editor!: LexicalEditor;
	render(
		<LexicalComposer
			initialConfig={{
				namespace: "terminal-directive-test",
				onError: (error) => {
					throw error;
				},
				nodes: [
					TerminalDirectiveNode,
					FileBadgeNode,
					ImageBadgeNode,
					CustomTagBadgeNode,
				],
			}}
		>
			<TerminalDirectivePlugin enabled onDirectiveChange={onDirectiveChange} />
			<CaptureEditor
				onReady={(nextEditor) => {
					editor = nextEditor;
				}}
			/>
		</LexicalComposer>,
	);
	return editor;
}

describe("TerminalDirectivePlugin", () => {
	it("treats a file badge after the directive as content", () => {
		const onDirectiveChange = vi.fn();
		const editor = renderPlugin(onDirectiveChange);

		act(() => {
			editor.update(
				() => {
					const paragraph = $createParagraphNode();
					paragraph.append(
						$createTerminalDirectiveNode(),
						$createTextNode(" "),
					);
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});
		expect(onDirectiveChange).toHaveBeenLastCalledWith({
			active: true,
			emptyAfter: true,
		});

		act(() => {
			editor.update(
				() => {
					$getRoot().clear();
					const paragraph = $createParagraphNode();
					paragraph.append(
						$createTerminalDirectiveNode(),
						$createTextNode(" "),
						$createFileBadgeNode("/tmp/src/foo.ts"),
					);
					$getRoot().append(paragraph);
				},
				{ discrete: true },
			);
		});

		expect(onDirectiveChange).toHaveBeenLastCalledWith({
			active: true,
			emptyAfter: false,
		});
	});
});
