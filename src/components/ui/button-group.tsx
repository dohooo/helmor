import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonGroupVariants = cva(
	[
		"inline-flex overflow-hidden rounded-[min(var(--radius-md),10px)] bg-transparent",
		"[&>[data-slot=button]:not(:first-child)]:rounded-l-none",
		"[&>[data-slot=button]:not(:first-child)]:border-l-0",
		"[&>[data-slot=button]:not(:last-child)]:rounded-r-none",
		"[&>[data-slot=button]:focus-visible]:relative",
		"[&>[data-slot=button]:focus-visible]:z-10",
	].join(" "),
	{
		variants: {
			orientation: {
				horizontal: "flex-row",
				vertical: "flex-col",
			},
		},
		defaultVariants: {
			orientation: "horizontal",
		},
	},
);

const buttonGroupSeparatorVariants = cva("bg-app-border/80", {
	variants: {
		orientation: {
			horizontal: "w-px self-stretch",
			vertical: "h-px w-full",
		},
	},
	defaultVariants: {
		orientation: "horizontal",
	},
});

function ButtonGroup({
	className,
	orientation = "horizontal",
	children,
	...props
}: React.HTMLAttributes<HTMLDivElement> &
	VariantProps<typeof buttonGroupVariants>) {
	return (
		<div
			role="group"
			data-slot="button-group"
			data-orientation={orientation}
			className={cn(buttonGroupVariants({ orientation, className }))}
			{...props}
		>
			{children}
		</div>
	);
}

function ButtonGroupSeparator({
	className,
	orientation = "vertical",
	...props
}: React.HTMLAttributes<HTMLDivElement> &
	VariantProps<typeof buttonGroupSeparatorVariants>) {
	return (
		<div
			data-slot="button-group-separator"
			data-orientation={orientation}
			className={cn(buttonGroupSeparatorVariants({ orientation, className }))}
			{...props}
		/>
	);
}

function ButtonGroupText({
	className,
	asChild = false,
	children,
	...props
}: React.HTMLAttributes<HTMLElement> & {
	asChild?: boolean;
}) {
	if (asChild && React.isValidElement(children)) {
		const child = children as React.ReactElement<
			React.HTMLAttributes<HTMLElement>
		>;
		return React.cloneElement<React.HTMLAttributes<HTMLElement>>(child, {
			...props,
			className: cn("leading-none", child.props.className, className),
		});
	}

	return (
		<span
			data-slot="button-group-text"
			className={cn("inline-flex h-8 items-center px-2", className)}
			{...props}
		>
			{children}
		</span>
	);
}

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText };
