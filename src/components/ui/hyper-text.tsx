import { memo, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DURATION = 600; // total scramble duration in ms
const INTERVAL = 40; // scramble tick interval in ms

type HyperTextProps = {
	/** The text to display. Animation triggers when this changes. */
	text: string;
	className?: string;
	/** Play the scramble animation on initial mount. Default false. */
	animateOnMount?: boolean;
};

/** Scramble-reveal text effect inspired by magicui.design/docs/components/hyper-text. */
export const HyperText = memo(function HyperText({
	text,
	className,
	animateOnMount = false,
}: HyperTextProps) {
	const [display, setDisplay] = useState(text);
	const iterationRef = useRef(0);
	const prevTextRef = useRef(text);
	const isFirstMount = useRef(true);

	const scramble = useCallback((target: string) => {
		iterationRef.current = 0;
		const totalSteps = Math.ceil(DURATION / INTERVAL);

		const timer = setInterval(() => {
			iterationRef.current += 1;
			const progress = iterationRef.current / totalSteps;

			// Progressively reveal characters left-to-right
			const revealed = Math.floor(progress * target.length);
			const chars = target.split("").map((char, i) => {
				if (i < revealed) return char;
				if (char === " ") return " ";
				return CHARS[Math.floor(Math.random() * CHARS.length)];
			});

			setDisplay(chars.join(""));

			if (iterationRef.current >= totalSteps) {
				clearInterval(timer);
				setDisplay(target);
			}
		}, INTERVAL);

		return timer;
	}, []);

	useEffect(() => {
		if (isFirstMount.current) {
			isFirstMount.current = false;
			if (animateOnMount) {
				const timer = scramble(text);
				return () => clearInterval(timer);
			}
			setDisplay(text);
			prevTextRef.current = text;
			return;
		}

		if (text === prevTextRef.current) return;
		prevTextRef.current = text;

		const timer = scramble(text);
		return () => clearInterval(timer);
	}, [text, scramble, animateOnMount]);

	return <span className={cn("inline-block", className)}>{display}</span>;
});
