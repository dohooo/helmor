import {
	$applyNodeReplacement,
	DecoratorNode,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

function TerminalLogo() {
	const { t } = useI18n();
	return (
		<span
			data-testid="terminal-directive"
			className="inline-flex h-5 select-none items-center gap-1 rounded-[5px] border border-primary/20 bg-primary/10 px-1 text-body text-primary leading-none"
			aria-label={t("terminalMode2")}
			contentEditable={false}
		>
			<svg
				aria-hidden
				viewBox="0 0 1024 1024"
				className="block size-3.5 shrink-0"
				focusable="false"
			>
				<path
					fill="currentColor"
					d="M921.6 42.6496H102.4c-27.136 0-53.248 11.008-72.3968 30.5664C10.752 92.7744 0 119.296 0 146.944v730.112c0 27.648 10.752 54.1696 30.0032 73.728 19.2 19.5584 45.2608 30.5664 72.3968 30.5664h819.2c27.136 0 53.248-11.008 72.3968-30.5664 19.2-19.5584 30.0032-46.08 30.0032-73.728V146.944c0-27.648-10.752-54.1696-30.0032-73.728A101.4784 101.4784 0 0 0 921.6 42.6496zM256 772.7616a50.5344 50.5344 0 0 1-28.416-8.8064 51.968 51.968 0 0 1-18.8928-23.3984 53.0432 53.0432 0 0 1 11.1104-56.832L388.4032 512 219.8016 340.2752a52.6848 52.6848 0 0 1 0.6144-73.1136 50.7392 50.7392 0 0 1 71.7824-0.6144l204.8 208.5888a52.6336 52.6336 0 0 1 0 73.728l-204.8 208.5888a50.688 50.688 0 0 1-36.1984 15.3088z m512 0h-256a50.688 50.688 0 0 1-36.1984-15.3088 52.6336 52.6336 0 0 1 0-73.728 50.688 50.688 0 0 1 36.1984-15.2576h256a50.688 50.688 0 0 1 36.1984 15.2576 52.6336 52.6336 0 0 1 0 73.728 50.688 50.688 0 0 1-36.1984 15.3088z"
				/>
			</svg>
			<span className="leading-none">{t("terminal")}</span>
		</span>
	);
}

export class TerminalDirectiveNode extends DecoratorNode<ReactNode> {
	static getType(): string {
		return "terminal-directive";
	}

	static clone(node: TerminalDirectiveNode): TerminalDirectiveNode {
		return new TerminalDirectiveNode(node.__key);
	}

	static importJSON(_serialized: SerializedLexicalNode): TerminalDirectiveNode {
		return $createTerminalDirectiveNode();
	}

	// biome-ignore lint/complexity/noUselessConstructor: Lexical requires a NodeKey-accepting constructor for node cloning.
	constructor(key?: NodeKey) {
		super(key);
	}

	exportJSON(): SerializedLexicalNode {
		return { type: TerminalDirectiveNode.getType(), version: 1 };
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

	getTextContent(): string {
		return "";
	}

	isInline(): true {
		return true;
	}

	decorate(): ReactNode {
		return <TerminalLogo />;
	}
}

export function $createTerminalDirectiveNode(): TerminalDirectiveNode {
	return $applyNodeReplacement(new TerminalDirectiveNode());
}

export function $isTerminalDirectiveNode(
	node: LexicalNode | null | undefined,
): node is TerminalDirectiveNode {
	return (
		node instanceof TerminalDirectiveNode ||
		node?.getType() === TerminalDirectiveNode.getType()
	);
}
