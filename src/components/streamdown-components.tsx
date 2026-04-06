/**
 * Custom component overrides for streamdown.
 *
 * Replaces streamdown's built-in code-block and table rendering
 * with shadcn/ui styled components.
 *
 * @see https://streamdown.ai/docs/components
 */
import type { ReactNode } from "react";
import {
	TableCopyDropdown,
	TableDownloadDropdown,
	useIsCodeFenceIncomplete,
} from "streamdown";
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
// Code block
// ---------------------------------------------------------------------------

/**
 * Block code override for `components.code`.
 *
 * Replaces the entire code rendering pipeline — syntax highlighting is
 * handled by the shadcn CodeBlock (shiki).  During streaming, an incomplete
 * fence shows a skeleton placeholder via `useIsCodeFenceIncomplete()`.
 */
export function StreamdownCode({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	const isIncomplete = useIsCodeFenceIncomplete();
	const language = className?.replace("language-", "") ?? "text";
	const code =
		typeof children === "string"
			? children.replace(/\n$/, "")
			: String(children ?? "");

	if (isIncomplete) {
		return <div className="my-4 h-24 animate-pulse rounded-md bg-muted" />;
	}

	return (
		<div className="my-4">
			<CodeBlock code={code} language={language as never}>
				<CodeBlockCopyButton />
			</CodeBlock>
		</div>
	);
}

/**
 * Inline code override for `components.inlineCode`.
 *
 * Prevents the `components.code` override from also capturing inline code.
 */
export function StreamdownInlineCode({ children }: { children?: ReactNode }) {
	return (
		<code className="rounded border border-border/50 bg-muted px-1 py-px text-[12px]">
			{children}
		</code>
	);
}

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

// ---------------------------------------------------------------------------
// Aggregated components map
// ---------------------------------------------------------------------------

// Cast needed because streamdown's Components index signature expects
// `Record<string, unknown> & ExtraProps` which is wider than our typed props.
export const streamdownComponents = {
	code: StreamdownCode,
	inlineCode: StreamdownInlineCode,
	table: StreamdownTable,
	thead: StreamdownTableHeader,
	tbody: StreamdownTableBody,
	tr: StreamdownTableRow,
	th: StreamdownTableHead,
	td: StreamdownTableCell,
} as Record<string, React.ComponentType<Record<string, unknown>>>;
