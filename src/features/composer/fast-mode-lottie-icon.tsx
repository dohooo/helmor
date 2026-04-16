import lottie from "lottie-web/build/player/lottie_svg";
import { useEffect, useRef } from "react";
import fastModeLightningAnimation from "@/assets/pikachu-lightning.json";
import { cn } from "@/lib/utils";

type FastModeLottieIconProps = {
	className?: string;
};

export function FastModeLottieIcon({ className }: FastModeLottieIconProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const animation = lottie.loadAnimation({
			container,
			renderer: "svg",
			loop: true,
			autoplay: true,
			animationData: fastModeLightningAnimation,
			rendererSettings: {
				preserveAspectRatio: "xMidYMid meet",
			},
		});
		if (typeof animation.setSpeed === "function") {
			animation.setSpeed(1.15);
		}

		return () => animation.destroy();
	}, []);

	return (
		<div
			ref={containerRef}
			aria-hidden="true"
			data-testid="fast-mode-lottie-icon"
			className={cn("pointer-events-none overflow-visible", className)}
		/>
	);
}
