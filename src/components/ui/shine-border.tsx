import type { CSSProperties, HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type ShineBorderProps = HTMLAttributes<HTMLDivElement> & {
	borderWidth?: number;
	duration?: number;
	shineColor?: string | string[];
};

export function ShineBorder({
	borderWidth = 1,
	duration = 14,
	shineColor = "#000000",
	className,
	style,
	...props
}: ShineBorderProps) {
	return (
		<div
			style={
				{
					"--border-width": `${borderWidth}px`,
					"--duration": `${duration}s`,
					backgroundImage: `radial-gradient(transparent, transparent, ${
						Array.isArray(shineColor) ? shineColor.join(",") : shineColor
					}, transparent, transparent)`,
					backgroundSize: "300% 300%",
					clipPath: "inset(0 0 var(--border-width) 0 round inherit)",
					mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
					WebkitMask:
						"linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
					WebkitMaskComposite: "xor",
					maskComposite: "exclude",
					padding: "var(--border-width)",
					...style,
				} as CSSProperties
			}
			className={cn(
				"pointer-events-none absolute inset-0 size-full rounded-[inherit] motion-safe:animate-shine will-change-[background-position]",
				className,
			)}
			{...props}
		/>
	);
}
