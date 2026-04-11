import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$applyNodeReplacement,
	$getNodeByKey,
	DecoratorNode,
	type DOMExportOutput,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
	type Spread,
} from "lexical";
import { Tag } from "lucide-react";
import type { ReactNode } from "react";
import type {
	ComposerCustomTag,
	ComposerPreviewPayload,
} from "@/lib/composer-insert";
import { ComposerPreviewBadge } from "./composer-preview-badge";

type SerializedCustomTagBadgeNode = Spread<
	ComposerCustomTag,
	SerializedLexicalNode
>;

function ComposerCustomTagBadge({
	customTag,
	nodeKey,
}: {
	customTag: ComposerCustomTag;
	nodeKey: NodeKey;
}) {
	const [editor] = useLexicalComposerContext();

	return (
		<ComposerPreviewBadge
			icon={
				<Tag
					className="size-3 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
			}
			label={customTag.label}
			preview={customTag.preview ?? null}
			removeLabel="Remove tag"
			onRemove={() => {
				editor.update(() => {
					const node = $getNodeByKey(nodeKey);
					if ($isCustomTagBadgeNode(node)) node.remove();
				});
			}}
		/>
	);
}

export class CustomTagBadgeNode extends DecoratorNode<ReactNode> {
	__id: string;
	__label: string;
	__submitText: string;
	__preview: ComposerPreviewPayload | null;

	static getType(): string {
		return "custom-tag-badge";
	}

	static clone(node: CustomTagBadgeNode): CustomTagBadgeNode {
		return new CustomTagBadgeNode(
			{
				id: node.__id,
				label: node.__label,
				submitText: node.__submitText,
				preview: node.__preview,
			},
			node.__key,
		);
	}

	static importJSON(
		serializedNode: SerializedCustomTagBadgeNode,
	): CustomTagBadgeNode {
		return $createCustomTagBadgeNode({
			id: serializedNode.id,
			label: serializedNode.label,
			submitText: serializedNode.submitText,
			preview: serializedNode.preview,
		});
	}

	constructor(customTag: ComposerCustomTag, key?: NodeKey) {
		super(key);
		this.__id = customTag.id;
		this.__label = customTag.label;
		this.__submitText = customTag.submitText;
		this.__preview = customTag.preview ?? null;
	}

	exportJSON(): SerializedCustomTagBadgeNode {
		return {
			type: "custom-tag-badge",
			version: 1,
			id: this.__id,
			label: this.__label,
			submitText: this.__submitText,
			...(this.__preview ? { preview: this.__preview } : {}),
		};
	}

	createDOM(): HTMLElement {
		const span = document.createElement("span");
		span.style.display = "inline";
		return span;
	}

	updateDOM(): false {
		return false;
	}

	exportDOM(): DOMExportOutput {
		const span = document.createElement("span");
		span.textContent = this.__label;
		return { element: span };
	}

	isInline(): true {
		return true;
	}

	getCustomTag(): ComposerCustomTag {
		return {
			id: this.__id,
			label: this.__label,
			submitText: this.__submitText,
			...(this.__preview ? { preview: this.__preview } : {}),
		};
	}

	decorate(): ReactNode {
		return (
			<ComposerCustomTagBadge
				customTag={this.getCustomTag()}
				nodeKey={this.__key}
			/>
		);
	}
}

export function $createCustomTagBadgeNode(
	customTag: ComposerCustomTag,
): CustomTagBadgeNode {
	return $applyNodeReplacement(new CustomTagBadgeNode(customTag));
}

export function $isCustomTagBadgeNode(
	node: LexicalNode | null | undefined,
): node is CustomTagBadgeNode {
	return node instanceof CustomTagBadgeNode;
}
