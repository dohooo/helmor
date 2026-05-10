import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useVoiceModeActive } from "./voice-mode-store";

type VoiceModeBarProps = {
	/** Total slot height (visible bar + top gap) when voice mode is active.
	 *  Should match the composer's `VOICE_SHRINK_PX` so the outer flex
	 *  column's total height stays constant. */
	height?: number;
	/** Vertical breathing room between the composer's bottom edge and the
	 *  visible bar. Carved out of the slot via `padding-top` so the bar's
	 *  visual height is `height - gap` (default 40 - 8 = 32 px). */
	gap?: number;
	className?: string;
	children?: ReactNode;
};

/**
 * Voice-mode bar slot. The outer element occupies `height` px when voice
 * mode is active (0 when inactive); the inner element fills `height - gap`
 * px below a `gap`-px top padding -- giving us a visible bar separated
 * from the composer above by a small gap.
 *
 * Both height and padding-top transition together, so the bar's visible
 * area expands and contracts in lock-step with the composer's textarea
 * shrinkage.
 *
 * Default visual is a placeholder `bg-muted` rectangle. Pass `children`
 * to fill it with real content (recording indicator, transcript, mute
 * button, etc.).
 */
export function VoiceModeBar({
	height = 40,
	gap = 8,
	className,
	children,
}: VoiceModeBarProps) {
	const active = useVoiceModeActive();
	return (
		<div
			className="overflow-hidden transition-[height,padding-top] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
			data-voice-bar=""
			data-voice-active={active ? "" : undefined}
			style={{
				height: active ? `${height}px` : "0px",
				paddingTop: active ? `${gap}px` : "0px",
			}}
		>
			<div
				className={cn(
					"h-full w-full rounded-md bg-muted transition-opacity duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
					className,
				)}
				style={{ opacity: active ? 1 : 0 }}
			>
				{children}
			</div>
		</div>
	);
}
