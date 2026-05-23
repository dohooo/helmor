import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { InboxActionsRow } from "./actions";

export type InboxSourceLayoutProps = {
	actions?: ReactNode;
	children: ReactNode;
	horizontalPaddingClass: string;
	actionsClassName?: string;
	scrollClassName?: string;
	contentClassName?: string;
};

export const InboxSourceLayout = forwardRef<
	HTMLDivElement,
	InboxSourceLayoutProps
>(function InboxSourceLayout(
	{
		actions,
		children,
		actionsClassName,
		horizontalPaddingClass,
		scrollClassName,
		contentClassName,
	},
	ref,
) {
	return (
		<>
			{actions ? (
				<div className={cn("mt-1.5", horizontalPaddingClass, actionsClassName)}>
					<InboxActionsRow>{actions}</InboxActionsRow>
				</div>
			) : null}
			<div
				ref={ref}
				className={cn(
					"scrollbar-stable min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:thin]",
					horizontalPaddingClass,
					actions ? "mt-1" : "mt-[7px]",
					scrollClassName,
				)}
			>
				<div
					className={cn(
						"flex w-[calc(100%+12px)] flex-col gap-2 pb-3",
						contentClassName,
					)}
				>
					{children}
				</div>
			</div>
		</>
	);
});
