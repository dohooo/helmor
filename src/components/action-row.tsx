import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ActionRowProps = {
	leading: ReactNode;
	trailing?: ReactNode;
	/** Absolute overlays (e.g. ShineBorder, gradient fills) */
	overlay?: ReactNode;
	className?: string;
};

/** Shared row shell for the composer action bar (auto-close, permission prompts). */
export function ActionRow({
	leading,
	trailing,
	overlay,
	className,
}: ActionRowProps) {
	return (
		<div
			className={cn(
				"relative flex items-center justify-between overflow-hidden border border-primary/40 bg-background px-3 pb-1 pt-1.5",
				className,
			)}
		>
			{overlay}
			<div className="flex min-w-0 items-center gap-1.5">{leading}</div>
			{trailing != null && (
				<div className="flex shrink-0 items-center gap-1.5">{trailing}</div>
			)}
		</div>
	);
}

type ActionRowButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	active?: boolean;
};

export function ActionRowButton({
	active,
	className,
	children,
	...props
}: ActionRowButtonProps) {
	const isActive = active ?? props["aria-pressed"] === true;
	const buttonColorClass =
		"h-7 cursor-pointer gap-1 rounded-[3px] px-2.5 text-[12px] leading-none tracking-[0.02em] disabled:cursor-not-allowed disabled:opacity-60";

	return (
		<Button
			type="button"
			variant={isActive ? "default" : "outline"}
			size="sm"
			className={cn(
				buttonColorClass,
				!isActive &&
					"bg-transparent text-muted-foreground hover:text-foreground dark:bg-transparent",
				className,
			)}
			aria-pressed={isActive}
			{...props}
		>
			{children}
		</Button>
	);
}
