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
import { Tag, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ComposerCustomTag } from "@/lib/composer-insert";

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
		<span className="mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded border border-border/60 align-middle text-[12px] transition-colors hover:border-muted-foreground/40 hover:bg-accent/40">
			<span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
				<Tag
					className="size-3 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
				<span className="max-w-[200px] truncate text-muted-foreground">
					{customTag.label}
				</span>
			</span>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				className="text-muted-foreground/40 hover:text-muted-foreground"
				onMouseDown={(e) => {
					e.preventDefault();
					e.stopPropagation();
				}}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					editor.update(() => {
						const node = $getNodeByKey(nodeKey);
						if ($isCustomTagBadgeNode(node)) node.remove();
					});
				}}
			>
				<X className="size-3" strokeWidth={1.8} />
			</Button>
		</span>
	);
}

export class CustomTagBadgeNode extends DecoratorNode<ReactNode> {
	__id: string;
	__label: string;
	__submitText: string;

	static getType(): string {
		return "custom-tag-badge";
	}

	static clone(node: CustomTagBadgeNode): CustomTagBadgeNode {
		return new CustomTagBadgeNode(
			{
				id: node.__id,
				label: node.__label,
				submitText: node.__submitText,
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
		});
	}

	constructor(customTag: ComposerCustomTag, key?: NodeKey) {
		super(key);
		this.__id = customTag.id;
		this.__label = customTag.label;
		this.__submitText = customTag.submitText;
	}

	exportJSON(): SerializedCustomTagBadgeNode {
		return {
			type: "custom-tag-badge",
			version: 1,
			id: this.__id,
			label: this.__label,
			submitText: this.__submitText,
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
