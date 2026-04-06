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
import type { ReactNode } from "react";
import { TableCopyDropdown, TableDownloadDropdown } from "streamdown";
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

// ---------------------------------------------------------------------------
// Aggregated components map
// ---------------------------------------------------------------------------

export const streamdownComponents = {
	table: StreamdownTable,
	thead: StreamdownTableHeader,
	tbody: StreamdownTableBody,
	tr: StreamdownTableRow,
	th: StreamdownTableHead,
	td: StreamdownTableCell,
} as Record<string, React.ComponentType<Record<string, unknown>>>;
