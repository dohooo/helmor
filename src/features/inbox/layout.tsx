import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type InboxSourceLayoutProps = {
	actions?: ReactNode;
	children: ReactNode;
	horizontalPaddingClass: string;
};

export const InboxSourceLayout = forwardRef<
	HTMLDivElement,
	InboxSourceLayoutProps
>(function InboxSourceLayout(
	{ actions, children, horizontalPaddingClass },
	ref,
) {
	return (
		<>
			{actions ? (
				<div
					className={cn(
						"mt-1.5 flex h-7 min-w-0 items-center gap-1.5",
						horizontalPaddingClass,
					)}
				>
					{actions}
				</div>
			) : null}
			<div
				ref={ref}
				className={cn(
					"scrollbar-stable min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:thin]",
					horizontalPaddingClass,
					actions ? "mt-1" : "mt-[7px]",
				)}
			>
				<div className="flex w-[calc(100%+12px)] flex-col gap-2 pb-3">
					{children}
				</div>
			</div>
		</>
	);
});
