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

/** Button styled identically to the "Enable Auto Close" button. */
export function ActionRowButton({
	active,
	className,
	children,
	...props
}: ActionRowButtonProps) {
	return (
		<Button
			type="button"
			variant={active ? "default" : "outline"}
			size="sm"
			className={cn(
				"h-7 cursor-pointer gap-1 rounded-[3px] border-border/45 bg-background/70 px-2.5 text-[12px] leading-none tracking-[0.02em] text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
				active &&
					"border-transparent bg-foreground text-background hover:bg-foreground/90",
				className,
			)}
			{...props}
		>
			{children}
		</Button>
	);
}
