import type { ReactNode } from "react";
import type { PendingUserInput } from "@/features/conversation/pending-user-input";
import { cn } from "@/lib/utils";
import type { UserInputResponseHandler } from "../user-input";

export type UserInputPanelProps = {
	userInput: PendingUserInput;
	disabled?: boolean;
	onResponse: UserInputResponseHandler;
};

/**
 * Shared card wrapper for composer-takeover panels (UserInputPanel,
 * PermissionPanel, GoalReplaceConfirm). Provides internal padding;
 * border / background / rounded corners come from the composer shell.
 */
export function UserInputCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return <div className={cn("px-4 py-3", className)}>{children}</div>;
}

export function autosizeTextarea(element: HTMLTextAreaElement | null) {
	if (!element) return;
	element.style.height = "0px";
	element.style.height = `${element.scrollHeight}px`;
}

export const INLINE_TEXTAREA_CLASS =
	"min-h-0 resize-none overflow-hidden rounded-none border-0 !bg-transparent px-1 py-0.5 leading-5 shadow-none placeholder:text-muted-foreground/55 focus-visible:ring-0 disabled:!bg-transparent dark:!bg-transparent dark:disabled:!bg-transparent";
