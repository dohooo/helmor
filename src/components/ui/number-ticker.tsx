import { useMotionValue, useSpring } from "motion/react";
import { type ComponentPropsWithoutRef, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
	value: number;
	direction?: "up" | "down";
	delay?: number;
}

export function NumberTicker({
	value,
	direction = "up",
	delay = 0,
	className,
	...props
}: NumberTickerProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const motionValue = useMotionValue(direction === "down" ? value : 0);
	const springValue = useSpring(motionValue, {
		damping: 40,
		stiffness: 200,
	});

	useEffect(() => {
		const timer = setTimeout(() => {
			motionValue.set(value);
		}, delay * 1000);

		return () => clearTimeout(timer);
	}, [motionValue, delay, value]);

	useEffect(
		() =>
			springValue.on("change", (latest) => {
				if (ref.current) {
					ref.current.textContent = String(Math.round(latest));
				}
			}),
		[springValue],
	);

	return (
		<span
			ref={ref}
			className={cn("inline-block tabular-nums", className)}
			{...props}
		>
			{value}
		</span>
	);
}
