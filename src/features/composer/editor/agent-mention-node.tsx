import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$applyNodeReplacement,
	$getNodeByKey,
	DecoratorNode,
	type DOMExportOutput,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { InlineBadge } from "@/components/inline-badge";

type SerializedAgentMentionNode = SerializedLexicalNode;

function ComposerAgentMentionBadge({ nodeKey }: { nodeKey: NodeKey }) {
	const [editor] = useLexicalComposerContext();

	return (
		<InlineBadge
			icon={
				<Bot
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
			}
			label="agent"
			removeLabel="Remove agent mention"
			onRemove={() => {
				editor.update(() => {
					const node = $getNodeByKey(nodeKey);
					if ($isAgentMentionNode(node)) node.remove();
				});
			}}
		/>
	);
}

export class AgentMentionNode extends DecoratorNode<ReactNode> {
	static getType(): string {
		return "agent-mention";
	}

	static clone(node: AgentMentionNode): AgentMentionNode {
		return new AgentMentionNode(node.__key);
	}

	static importJSON(): AgentMentionNode {
		return $createAgentMentionNode();
	}

	exportJSON(): SerializedAgentMentionNode {
		return {
			type: "agent-mention",
			version: 1,
		};
	}

	createDOM(): HTMLElement {
		const span = document.createElement("span");
		span.style.display = "inline-flex";
		span.style.alignItems = "center";
		span.style.justifyContent = "center";
		span.style.lineHeight = "1";
		span.style.verticalAlign = "-1px";
		return span;
	}

	updateDOM(): false {
		return false;
	}

	exportDOM(): DOMExportOutput {
		const span = document.createElement("span");
		span.textContent = "@agent";
		return { element: span };
	}

	getTextContent(): string {
		return "@agent";
	}

	isInline(): true {
		return true;
	}

	decorate(): ReactNode {
		return <ComposerAgentMentionBadge nodeKey={this.__key} />;
	}
}

export function $createAgentMentionNode(): AgentMentionNode {
	return $applyNodeReplacement(new AgentMentionNode());
}

export function $isAgentMentionNode(
	node: LexicalNode | null | undefined,
): node is AgentMentionNode {
	return node instanceof AgentMentionNode;
}
