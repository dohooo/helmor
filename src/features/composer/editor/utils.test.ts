import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	createEditor,
} from "lexical";
import { describe, expect, it } from "vitest";
import {
	$createAgentMentionNode,
	AgentMentionNode,
} from "./agent-mention-node";
import { $extractComposerContent } from "./utils";

describe("$extractComposerContent", () => {
	it("serializes an agent mention badge as @agent text", () => {
		const editor = createEditor({
			namespace: "extract-composer-content-test",
			nodes: [AgentMentionNode],
			onError: (error) => {
				throw error;
			},
		});

		editor.update(
			() => {
				const paragraph = $createParagraphNode();
				paragraph.append(
					$createTextNode("ask "),
					$createAgentMentionNode(),
					$createTextNode(" now"),
				);
				$getRoot().append(paragraph);
			},
			{ discrete: true },
		);

		let text = "";
		editor.getEditorState().read(() => {
			text = $extractComposerContent().text;
		});

		expect(text).toBe("ask @agent now");
	});
});
