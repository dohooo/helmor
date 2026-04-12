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
				"relative flex items-center justify-between overflow-hidden border border-border/40 bg-background px-3 pb-1 pt-1.5",
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
	if (active) {
		return (
			<Button
				type="button"
				size="sm"
				className={cn(
					"h-7 cursor-pointer gap-1 rounded-[3px] border-transparent bg-foreground px-2.5 text-[12px] leading-none tracking-[0.02em] text-background shadow-none transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_90%,black_10%)] hover:text-background disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				{...props}
			>
				{children}
			</Button>
		);
	}

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className={cn(
				"h-7 cursor-pointer gap-1 rounded-[3px] px-2.5 text-[12px] leading-none tracking-[0.02em] disabled:cursor-not-allowed disabled:opacity-60",
				className,
			)}
			{...props}
		>
			{children}
		</Button>
	);
}
