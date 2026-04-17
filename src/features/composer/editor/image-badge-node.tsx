/**
 * Lexical DecoratorNode for inline image badges in the composer.
 *
 * Renders a non-editable badge (icon + filename + remove button) inline
 * with text. Hovering the badge opens a lightweight preview card without
 * stealing focus from the editor.
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
import { ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import { basename } from "@/lib/path-util";
import { ComposerPreviewBadge } from "./composer-preview-badge";

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
	const fileName = basename(imagePath);

	return (
		<ComposerPreviewBadge
			icon={
				<ImageIcon className="size-3 shrink-0 text-chart-3" strokeWidth={1.8} />
			}
			label={fileName}
			removeLabel="Remove image"
			preview={{
				kind: "image",
				title: fileName,
				path: imagePath,
			}}
			onRemove={() => {
				editor.update(() => {
					const node = $getImageBadgeNodeByKey(nodeKey);
					if (node) node.remove();
				});
			}}
		/>
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
