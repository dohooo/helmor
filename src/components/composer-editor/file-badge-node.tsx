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
import { FileText, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

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
		<span className="mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded border border-border/60 align-middle text-[12px] transition-colors hover:border-muted-foreground/40 hover:bg-accent/40">
			<span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
				<FileText
					className="size-3 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
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
					e.preventDefault();
					e.stopPropagation();
				}}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					editor.update(() => {
						const node = $getNodeByKey(nodeKey);
						if ($isFileBadgeNode(node)) node.remove();
					});
				}}
			>
				<X className="size-3" strokeWidth={1.8} />
			</Button>
		</span>
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
