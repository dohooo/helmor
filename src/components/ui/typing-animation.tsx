import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** One segment of styled text revealed together as part of the typing flow. */
export type TypingSegment = {
	text: string;
	className?: string;
};

type TypingAnimationProps = {
	/**
	 * Text to reveal character by character. Pass a plain string for a single
	 * style, or an array of segments to style portions (e.g. bold) of the line
	 * while keeping a single continuous typing flow.
	 */
	text: string | TypingSegment[];
	/** Ms between each character. Default 60. */
	duration?: number;
	/** Ms before typing starts after mount. Default 0. */
	delay?: number;
	className?: string;
};

/** Typewriter reveal effect inspired by magicui.design/docs/components/typing-animation. */
export const TypingAnimation = memo(function TypingAnimation({
	text,
	duration = 60,
	delay = 0,
	className,
}: TypingAnimationProps) {
	const segments: TypingSegment[] = Array.isArray(text) ? text : [{ text }];
	const fullText = segments.map((s) => s.text).join("");

	const [revealed, setRevealed] = useState(0);

	useEffect(() => {
		setRevealed(0);

		let interval: number | null = null;
		const start = window.setTimeout(() => {
			interval = window.setInterval(() => {
				setRevealed((prev) => {
					if (prev >= fullText.length) {
						if (interval !== null) window.clearInterval(interval);
						return prev;
					}
					return prev + 1;
				});
			}, duration);
		}, delay);

		return () => {
			window.clearTimeout(start);
			if (interval !== null) window.clearInterval(interval);
		};
	}, [fullText, duration, delay]);

	let consumed = 0;
	return (
		<span className={cn("inline-block", className)}>
			{segments.map((seg, idx) => {
				const segStart = consumed;
				consumed += seg.text.length;
				const revealedInSeg = Math.max(
					0,
					Math.min(revealed - segStart, seg.text.length),
				);
				if (revealedInSeg === 0) return null;
				return (
					<span key={idx} className={seg.className}>
						{seg.text.slice(0, revealedInSeg)}
					</span>
				);
			})}
		</span>
	);
});
