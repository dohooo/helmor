import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as React from "react";

import { cn } from "@/lib/utils";

type ScrollAreaProps = React.ComponentPropsWithoutRef<
	typeof ScrollAreaPrimitive.Root
> & {
	overlay?: React.ReactNode;
	viewportClassName?: string;
	viewportProps?: React.HTMLAttributes<HTMLDivElement> & {
		[key: `data-${string}`]: string | boolean | undefined;
		nonce?: string;
	};
	viewportTestId?: string;
	viewportVirtuosoScroller?: string;
	viewportRef?: React.Ref<HTMLDivElement>;
	scrollbarClassName?: string;
	thumbClassName?: string;
	scrollbars?: "vertical" | "horizontal" | "both" | "none";
};

const ScrollArea = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.Root>,
	ScrollAreaProps
>(
	(
		{
			className,
			children,
			overlay,
			viewportClassName,
			viewportProps,
			viewportTestId,
			viewportVirtuosoScroller,
			viewportRef,
			scrollbarClassName,
			thumbClassName,
			scrollbars = "vertical",
			type = "scroll",
			scrollHideDelay = 700,
			...props
		},
		ref,
	) => {
		const showVertical = scrollbars === "vertical" || scrollbars === "both";
		const showHorizontal = scrollbars === "horizontal" || scrollbars === "both";

		return (
			<ScrollAreaPrimitive.Root
				ref={ref}
				data-slot="scroll-area"
				type={type}
				scrollHideDelay={scrollHideDelay}
				className={cn("relative overflow-hidden", className)}
				{...props}
			>
				<ScrollAreaPrimitive.Viewport
					{...viewportProps}
					ref={viewportRef}
					data-slot="scroll-area-viewport"
					data-testid={viewportTestId}
					data-virtuoso-scroller={viewportVirtuosoScroller}
					className={cn("h-full w-full rounded-[inherit]", viewportClassName)}
				>
					{children}
				</ScrollAreaPrimitive.Viewport>

				{overlay}

				{showVertical ? (
					<ScrollBar
						orientation="vertical"
						className={scrollbarClassName}
						thumbClassName={thumbClassName}
					/>
				) : null}

				{showHorizontal ? (
					<ScrollBar
						orientation="horizontal"
						className={scrollbarClassName}
						thumbClassName={thumbClassName}
					/>
				) : null}

				{scrollbars === "both" ? <ScrollAreaPrimitive.Corner /> : null}
			</ScrollAreaPrimitive.Root>
		);
	},
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

type ScrollBarProps = React.ComponentPropsWithoutRef<
	typeof ScrollAreaPrimitive.Scrollbar
> & {
	thumbClassName?: string;
};

const ScrollBar = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.Scrollbar>,
	ScrollBarProps
>(({ className, orientation = "vertical", thumbClassName, ...props }, ref) => (
	<ScrollAreaPrimitive.Scrollbar
		ref={ref}
		data-slot="scroll-area-scrollbar"
		orientation={orientation}
		className={cn(
			"touch-none select-none p-[2px] transition-opacity data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100",
			orientation === "vertical" ? "flex h-full w-2" : "flex h-2 flex-col",
			className,
		)}
		{...props}
	>
		<ScrollAreaPrimitive.Thumb
			data-slot="scroll-area-thumb"
			className={cn(
				"relative flex-1 rounded-full bg-app-scrollbar-thumb hover:bg-app-scrollbar-thumb-hover",
				thumbClassName,
			)}
		/>
	</ScrollAreaPrimitive.Scrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.Scrollbar.displayName;

export { ScrollArea, ScrollBar };
