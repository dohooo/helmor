/**
 * Lexical DecoratorNode for inline file badges in the composer.
 *
 * For non-image files (code, PDF, etc.) dragged or referenced in the editor.
 * Renders as an inline badge with a file icon + filename + remove button.
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
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { ComposerPreviewBadge } from "./composer-preview-badge";

type SerializedFileBadgeNode = Spread<
	{ filePath: string },
	SerializedLexicalNode
>;

function ComposerFileBadge({
	filePath,
	nodeKey,
}: {
	filePath: string;
	nodeKey: NodeKey;
}) {
	const [editor] = useLexicalComposerContext();
	const fileName = filePath.split("/").pop() ?? filePath;

	return (
		<ComposerPreviewBadge
			icon={
				<FileText
					className="size-3 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
			}
			label={fileName}
			removeLabel="Remove file"
			onRemove={() => {
				editor.update(() => {
					const node = $getNodeByKey(nodeKey);
					if ($isFileBadgeNode(node)) node.remove();
				});
			}}
		/>
	);
}

export class FileBadgeNode extends DecoratorNode<ReactNode> {
	__filePath: string;

	static getType(): string {
		return "file-badge";
	}

	static clone(node: FileBadgeNode): FileBadgeNode {
		return new FileBadgeNode(node.__filePath, node.__key);
	}

	static importJSON(serializedNode: SerializedFileBadgeNode): FileBadgeNode {
		return $createFileBadgeNode(serializedNode.filePath);
	}

	constructor(filePath: string, key?: NodeKey) {
		super(key);
		this.__filePath = filePath;
	}

	exportJSON(): SerializedFileBadgeNode {
		return {
			type: "file-badge",
			version: 1,
			filePath: this.__filePath,
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
		span.textContent = `@${this.__filePath}`;
		return { element: span };
	}

	isInline(): true {
		return true;
	}

	getFilePath(): string {
		return this.__filePath;
	}

	decorate(): ReactNode {
		return (
			<ComposerFileBadge filePath={this.__filePath} nodeKey={this.__key} />
		);
	}
}

export function $createFileBadgeNode(filePath: string): FileBadgeNode {
	return $applyNodeReplacement(new FileBadgeNode(filePath));
}

export function $isFileBadgeNode(
	node: LexicalNode | null | undefined,
): node is FileBadgeNode {
	return node instanceof FileBadgeNode;
}
