import { useMotionValue, useSpring } from "motion/react";
import { type ComponentPropsWithoutRef, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
	value: number;
	direction?: "up" | "down";
	delay?: number;
	/** When false, mount renders `value` directly and only later changes spring.
	 * Use for numbers that are part of repeatedly remounted lists (e.g. inspector
	 * change rows) where the entry animation reruns every workspace switch. */
	animateOnMount?: boolean;
}

export function NumberTicker({
	value,
	direction = "up",
	delay = 0,
	animateOnMount = true,
	className,
	...props
}: NumberTickerProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const initialMotion = animateOnMount
		? direction === "down"
			? value
			: 0
		: value;
	const motionValue = useMotionValue(initialMotion);
	const springValue = useSpring(motionValue, {
		damping: 100,
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
