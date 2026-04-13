import lottie from "lottie-web/build/player/lottie_svg";
import { useEffect, useMemo, useRef } from "react";
import logoAnimation from "@/assets/helmor-logo-animation.json";
import { resolveTheme, useSettings } from "@/lib/settings";

// Deep-clone the animation JSON and swap colours for a given theme.
// Background layer is always transparent (container provides bg).
// Dark: white shapes, Light: dark shapes.
function themedAnimationData(theme: "light" | "dark") {
	const data = JSON.parse(JSON.stringify(logoAnimation));

	const darkFill = [0.055, 0.055, 0.055, 1]; // #0E0E0E
	for (const layer of data.layers) {
		// Light mode: recolour shape fills to dark
		if (theme === "light" && layer.ty === 4 && layer.shapes) {
			for (const group of layer.shapes) {
				for (const item of group.it ?? []) {
					if (item.ty === "fl") {
						item.c.k = darkFill;
					}
				}
			}
		}
		// Always make background layer transparent
		if (layer.ty === 1) {
			layer.sc = "#00000000";
		}
	}
	return data;
}

interface HelmorLogoAnimatedProps {
	/** CSS width/height */
	size?: string | number;
	loop?: boolean;
	autoplay?: boolean;
	className?: string;
}

export function HelmorLogoAnimated({
	size,
	loop = true,
	autoplay = true,
	className,
}: HelmorLogoAnimatedProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const { settings } = useSettings();
	const effectiveTheme = resolveTheme(settings.theme);
	const animData = useMemo(
		() => themedAnimationData(effectiveTheme),
		[effectiveTheme],
	);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const anim = lottie.loadAnimation({
			container: el,
			renderer: "svg",
			loop,
			autoplay,
			animationData: animData,
		});

		return () => anim.destroy();
	}, [loop, autoplay, animData]);

	return (
		<div
			ref={containerRef}
			className={className}
			style={{ width: size, height: size }}
		/>
	);
}
