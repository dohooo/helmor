import type { ButtonHTMLAttributes, ReactNode } from "react";
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
				"relative flex items-center justify-between overflow-hidden border border-app-border/40 bg-app-sidebar px-3 pb-1 pt-1.5",
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
		<button
			type="button"
			className={cn(
				"inline-flex h-7 cursor-pointer items-center gap-1 rounded-[3px] border border-app-border/45 bg-app-base/70 px-2.5 text-[12px] font-medium leading-none tracking-[0.02em] text-app-foreground-soft transition-colors hover:bg-app-base hover:text-app-foreground disabled:cursor-not-allowed disabled:opacity-60",
				active &&
					"border-transparent bg-foreground text-background hover:bg-foreground/90",
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}
