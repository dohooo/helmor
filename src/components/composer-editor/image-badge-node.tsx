/**
 * Lexical DecoratorNode for inline image badges in the composer.
 *
 * Renders a non-editable badge (icon + filename + remove button) inline
 * with text. The badge is visually identical to the ImagePreviewBadge
 * used elsewhere, but without the click-to-preview modal (to avoid
 * stealing focus from the editor).
 */

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
import { ImageIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Serialization type
// ---------------------------------------------------------------------------

type SerializedImageBadgeNode = Spread<
	{ imagePath: string },
	SerializedLexicalNode
>;

// ---------------------------------------------------------------------------
// React badge component rendered inside the editor
// ---------------------------------------------------------------------------

function ComposerImageBadge({
	imagePath,
	nodeKey,
}: {
	imagePath: string;
	nodeKey: NodeKey;
}) {
	const [editor] = useLexicalComposerContext();
	const fileName = imagePath.split("/").pop() ?? imagePath;

	return (
		<span className="mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded border border-border/60 align-middle text-[12px] transition-colors hover:border-muted-foreground/40 hover:bg-accent/40">
			<span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
				<ImageIcon className="size-3 shrink-0 text-chart-3" strokeWidth={1.8} />
				<span className="max-w-[200px] truncate text-muted-foreground">
					{fileName}
				</span>
			</span>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				className="text-muted-foreground/40 hover:text-muted-foreground"
				onMouseDown={(e) => {
					// Prevent editor from losing focus
					e.preventDefault();
					e.stopPropagation();
				}}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					editor.update(() => {
						const node = $getImageBadgeNodeByKey(nodeKey);
						if (node) node.remove();
					});
				}}
			>
				<X className="size-3" strokeWidth={1.8} />
			</Button>
		</span>
	);
}

// ---------------------------------------------------------------------------
// Lexical node
// ---------------------------------------------------------------------------

export class ImageBadgeNode extends DecoratorNode<ReactNode> {
	__imagePath: string;

	static getType(): string {
		return "image-badge";
	}

	static clone(node: ImageBadgeNode): ImageBadgeNode {
		return new ImageBadgeNode(node.__imagePath, node.__key);
	}

	static importJSON(serializedNode: SerializedImageBadgeNode): ImageBadgeNode {
		return $createImageBadgeNode(serializedNode.imagePath);
	}

	constructor(imagePath: string, key?: NodeKey) {
		super(key);
		this.__imagePath = imagePath;
	}

	exportJSON(): SerializedImageBadgeNode {
		return {
			type: "image-badge",
			version: 1,
			imagePath: this.__imagePath,
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
		span.textContent = `@${this.__imagePath}`;
		return { element: span };
	}

	isInline(): true {
		return true;
	}

	getImagePath(): string {
		return this.__imagePath;
	}

	decorate(): ReactNode {
		return (
			<ComposerImageBadge imagePath={this.__imagePath} nodeKey={this.__key} />
		);
	}
}

// ---------------------------------------------------------------------------
// Factory & type guard
// ---------------------------------------------------------------------------

export function $createImageBadgeNode(imagePath: string): ImageBadgeNode {
	return $applyNodeReplacement(new ImageBadgeNode(imagePath));
}

export function $isImageBadgeNode(
	node: LexicalNode | null | undefined,
): node is ImageBadgeNode {
	return node instanceof ImageBadgeNode;
}

function $getImageBadgeNodeByKey(key: NodeKey): ImageBadgeNode | null {
	const node = $getNodeByKey(key);
	return $isImageBadgeNode(node) ? node : null;
}
