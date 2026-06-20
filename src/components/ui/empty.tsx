import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { useLocalizedNode } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="empty"
			className={cn(
				"flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance",
				className,
			)}
			{...props}
		/>
	);
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="empty-header"
			className={cn("flex max-w-sm flex-col items-center gap-2", className)}
			{...props}
		/>
	);
}

const emptyMediaVariants = cva(
	"mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-transparent",
				icon: "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

function EmptyMedia({
	className,
	variant = "default",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
	return (
		<div
			data-slot="empty-icon"
			data-variant={variant}
			className={cn(emptyMediaVariants({ variant, className }))}
			{...props}
		/>
	);
}

function EmptyTitle({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	const localizedChildren = useLocalizedNode(children);
	return (
		<div
			data-slot="empty-title"
			className={cn("font-heading text-title font-medium", className)}
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function EmptyDescription({
	className,
	children,
	...props
}: React.ComponentProps<"p">) {
	const localizedChildren = useLocalizedNode(children);
	return (
		<div
			data-slot="empty-description"
			className={cn(
				"text-body/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
				className,
			)}
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function EmptyContent({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	const localizedChildren = useLocalizedNode(children);
	return (
		<div
			data-slot="empty-content"
			className={cn(
				"flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-body text-balance",
				className,
			)}
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

export {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
};
