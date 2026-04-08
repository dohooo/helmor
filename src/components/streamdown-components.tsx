/**
 * Custom component overrides for streamdown.
 *
 * Replaces streamdown's built-in table rendering
 * with shadcn/ui styled components.
 *
 * Code highlighting is handled by the @streamdown/code plugin.
 *
 * @see https://streamdown.ai/docs/components
 */
import {
	type ComponentType,
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { TableCopyDropdown, TableDownloadDropdown } from "streamdown";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai/code-block";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * Table override for `components.table`.
 *
 * Wraps content in `data-streamdown="table-wrapper"` so streamdown's
 * `TableCopyDropdown` / `TableDownloadDropdown` can locate the `<table>`
 * via `.closest()` + `.querySelector()`.
 */
export function StreamdownTable({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div data-streamdown="table-wrapper" className="my-4 flex flex-col gap-1">
			<div className="flex items-center justify-end gap-1">
				<TableCopyDropdown />
				<TableDownloadDropdown />
			</div>
			<Table className={cn("text-[11px]", className)}>{children}</Table>
		</div>
	);
}

export function StreamdownTableHeader({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return <TableHeader className={className}>{children}</TableHeader>;
}

export function StreamdownTableBody({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return <TableBody className={className}>{children}</TableBody>;
}

export function StreamdownTableRow({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return <TableRow className={className}>{children}</TableRow>;
}

export function StreamdownTableHead({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<TableHead className={cn("h-8 text-[11px] font-semibold", className)}>
			{children}
		</TableHead>
	);
}

export function StreamdownTableCell({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<TableCell className={cn("py-1.5 text-[11px]", className)}>
			{children}
		</TableCell>
	);
}

function childrenToText(children: ReactNode): string {
	if (typeof children === "string" || typeof children === "number") {
		return String(children);
	}
	if (Array.isArray(children)) {
		return children.map(childrenToText).join("");
	}
	if (isValidElement(children)) {
		const props = children.props as { children?: ReactNode };
		return childrenToText(props.children);
	}
	return "";
}

export function StreamdownPre({ children }: { children?: ReactNode }) {
	if (!isValidElement(children)) {
		return children;
	}

	const child = children as ReactElement<{
		children?: ReactNode;
		className?: string;
	}>;
	const className =
		typeof child.props.className === "string" ? child.props.className : "";
	const languageMatch = className.match(/language-([^\s]+)/);
	const language = languageMatch?.[1] ?? "";

	// Keep Streamdown's built-in Mermaid / special handling path intact.
	if (language.toLowerCase() === "mermaid") {
		return cloneElement(child as ReactElement<Record<string, unknown>>, {
			"data-block": "true",
		});
	}

	const code = childrenToText(child.props.children);
	return (
		<CodeBlock code={code} language={language}>
			<CodeBlockCopyButton />
		</CodeBlock>
	);
}

// ---------------------------------------------------------------------------
// Aggregated components map
// ---------------------------------------------------------------------------

export const streamdownComponents = {
	pre: StreamdownPre,
	table: StreamdownTable,
	thead: StreamdownTableHeader,
	tbody: StreamdownTableBody,
	tr: StreamdownTableRow,
	th: StreamdownTableHead,
	td: StreamdownTableCell,
} as Record<string, ComponentType<Record<string, unknown>>>;
