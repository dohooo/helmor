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
import { InlineBadge } from "@/components/inline-badge";
import { SourceIcon } from "@/features/inbox/source-icon";
import { STATE_TONE_CLASS } from "@/features/inbox/state-tone";
import {
	buildComposerPreviewLabel,
	type ComposerCustomTag,
	type ComposerPreviewPayload,
} from "@/lib/composer-insert";
import type {
	ContextCardSource,
	ContextCardStateTone,
} from "@/lib/sources/types";
import { cn } from "@/lib/utils";

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
	const icon = customTag.source ? (
		<SourceIcon
			source={customTag.source}
			size={14}
			className={cn(
				"shrink-0",
				customTag.stateTone
					? STATE_TONE_CLASS[customTag.stateTone]
					: "text-muted-foreground",
			)}
		/>
	) : (
		<Tag
			className="size-3.5 shrink-0 text-muted-foreground"
			strokeWidth={1.8}
		/>
	);

	const isEditableText = customTag.preview?.kind === "text";

	return (
		<InlineBadge
			icon={icon}
			label={customTag.label}
			preview={customTag.preview ?? null}
			removeLabel="Remove tag"
			onRemove={() => {
				editor.update(() => {
					const node = $getNodeByKey(nodeKey);
					if ($isCustomTagBadgeNode(node)) node.remove();
				});
			}}
			onEdit={
				isEditableText
					? (nextText) => {
							editor.update(() => {
								const node = $getNodeByKey(nodeKey);
								if ($isCustomTagBadgeNode(node)) node.setText(nextText);
							});
						}
					: undefined
			}
		/>
	);
}

export class CustomTagBadgeNode extends DecoratorNode<ReactNode> {
	__id: string;
	__label: string;
	__submitText: string;
	__preview: ComposerPreviewPayload | null;
	__source: ContextCardSource | undefined;
	__stateTone: ContextCardStateTone | undefined;

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
				source: node.__source,
				stateTone: node.__stateTone,
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
			source: serializedNode.source,
			stateTone: serializedNode.stateTone,
		});
	}

	constructor(customTag: ComposerCustomTag, key?: NodeKey) {
		super(key);
		this.__id = customTag.id;
		this.__label = customTag.label;
		this.__submitText = customTag.submitText;
		this.__preview = customTag.preview ?? null;
		this.__source = customTag.source;
		this.__stateTone = customTag.stateTone;
	}

	exportJSON(): SerializedCustomTagBadgeNode {
		return {
			type: "custom-tag-badge",
			version: 1,
			id: this.__id,
			label: this.__label,
			submitText: this.__submitText,
			...(this.__preview ? { preview: this.__preview } : {}),
			...(this.__source ? { source: this.__source } : {}),
			...(this.__stateTone ? { stateTone: this.__stateTone } : {}),
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
			...(this.__source ? { source: this.__source } : {}),
			...(this.__stateTone ? { stateTone: this.__stateTone } : {}),
		};
	}

	// 仅支持 text 类型预览的就地编辑：同步刷新 submitText / label / preview.text
	setText(nextText: string): void {
		const current = this.__preview;
		if (!current || current.kind !== "text") return;
		if (nextText === this.__submitText) return;
		const writable = this.getWritable();
		const nextLabel = buildComposerPreviewLabel(nextText, "text");
		writable.__submitText = nextText;
		writable.__label = nextLabel;
		writable.__preview = {
			kind: "text",
			title: nextLabel,
			text: nextText,
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
