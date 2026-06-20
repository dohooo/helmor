/**
 * Lexical DecoratorNode rendering the purple `/add-dir` pill inside the
 * composer editor.
 *
 * Selecting `/add-dir` from the slash-command popup inserts one of these
 * nodes followed by a space. Text typed after it becomes the query the
 * `AddDirTypeaheadPlugin` uses to filter the directory picker. Deleting
 * the pill (single Backspace press at the trailing edge) exits the
 * add-dir mode and removes the pill in one stroke — see the plugin's
 * KEY_BACKSPACE_COMMAND handler.
 */

import {
	$applyNodeReplacement,
	DecoratorNode,
	type DOMExportOutput,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { ReactNode } from "react";
import { I18nText } from "@/lib/i18n";

export class AddDirTriggerNode extends DecoratorNode<ReactNode> {
	static getType(): string {
		return "add-dir-trigger";
	}

	static clone(node: AddDirTriggerNode): AddDirTriggerNode {
		return new AddDirTriggerNode(node.__key);
	}

	static importJSON(_serialized: SerializedLexicalNode): AddDirTriggerNode {
		return $createAddDirTriggerNode();
	}

	// Default constructor from DecoratorNode suffices — no extra state to
	// initialize. The explicit constructor is still needed as a type
	// signature for Lexical (required for `clone`), but Biome flags a
	// trivial body as useless. We reference `NodeKey` here to silence that
	// while keeping the shape obvious.
	// biome-ignore lint/complexity/noUselessConstructor: Lexical requires a NodeKey-accepting constructor for node cloning.
	constructor(key?: NodeKey) {
		super(key);
	}

	exportJSON(): SerializedLexicalNode {
		return { type: AddDirTriggerNode.getType(), version: 1 };
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

	/**
	 * Plain-text export for prompt submission. `/add-dir` pills are meant
	 * to be stripped by the plugin before submit, but if the user ever
	 * sends a message with a dangling pill we render it as the literal
	 * `/add-dir` text so the downstream agent doesn't see a missing span.
	 */
	getTextContent(): string {
		return "/add-dir";
	}

	exportDOM(): DOMExportOutput {
		const span = document.createElement("span");
		span.textContent = "/add-dir";
		return { element: span };
	}

	isInline(): true {
		return true;
	}

	decorate(): ReactNode {
		return (
			<span
				data-testid="add-dir-pill"
				className="inline-flex h-5 items-center rounded-[5px] px-1 font-mono text-small leading-none bg-[color-mix(in_srgb,var(--workspace-pr-merged-accent)_10%,transparent)] text-[var(--workspace-pr-merged-accent)]"
			>
				<I18nText source={"/add-dir"} />
			</span>
		);
	}
}

export function $createAddDirTriggerNode(): AddDirTriggerNode {
	return $applyNodeReplacement(new AddDirTriggerNode());
}

export function $isAddDirTriggerNode(
	node: LexicalNode | null | undefined,
): node is AddDirTriggerNode {
	return node instanceof AddDirTriggerNode;
}
