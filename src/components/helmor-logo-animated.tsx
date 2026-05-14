import { useEffect, useState } from "react";
import logoDarkSrc from "@/assets/helmor-logo.png";
import logoLightSrc from "@/assets/helmor-logo-light.png";
import { resolveTheme, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

interface HelmorLogoAnimatedProps {
	/** CSS width/height */
	size?: string | number;
	loop?: boolean;
	autoplay?: boolean;
	className?: string;
}

function usePrefersReducedMotion() {
	const [reducedMotion, setReducedMotion] = useState(false);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") {
			return;
		}

		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const handleChange = () => setReducedMotion(query.matches);

		handleChange();
		query.addEventListener("change", handleChange);
		return () => query.removeEventListener("change", handleChange);
	}, []);

	return reducedMotion;
}

export function HelmorLogoAnimated({
	size,
	loop = true,
	autoplay = true,
	className,
}: HelmorLogoAnimatedProps) {
	const { settings } = useSettings();
	const effectiveTheme = resolveTheme(settings.theme);
	const reducedMotion = usePrefersReducedMotion();
	const shouldAnimate = autoplay && loop && !reducedMotion;

	if (shouldAnimate) {
		return (
			<HelmorLogoCss size={size} className={className} theme={effectiveTheme} />
		);
	}

	const src = effectiveTheme === "light" ? logoDarkSrc : logoLightSrc;

	return (
		<img
			aria-hidden="true"
			alt=""
			className={cn("block", className)}
			draggable={false}
			src={src}
			style={{ width: size, height: size }}
		/>
	);
}

function HelmorLogoCss({
	size,
	className,
	theme,
}: {
	size?: string | number;
	className?: string;
	theme: "light" | "dark";
}) {
	const color = theme === "light" ? "#0E0E0E" : "#FEFEFE";

	return (
		<svg
			aria-hidden="true"
			className={cn("block", className)}
			fill="none"
			style={{ width: size, height: size, color }}
			viewBox="0 0 1024 1024"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				className="helmor-logo-css-piece helmor-logo-css-piece-tl"
				d="M162 306.673V80.582L375.51 193.625V419.709L162 306.673Z"
			/>
			<path
				className="helmor-logo-css-piece helmor-logo-css-piece-ml"
				d="M376.057 454.357L162.553 341.314V567.399L376.057 680.442V454.357Z"
			/>
			<path
				className="helmor-logo-css-piece helmor-logo-css-piece-bl"
				d="M162 828.14V602.047L375.51 715.089V941.174L162 828.14Z"
			/>
			<path
				className="helmor-logo-css-piece helmor-logo-css-piece-bridge"
				d="M404.308 680.442V454.357L617.918 341.314V567.399L404.308 680.442Z"
			/>
			<path
				className="helmor-logo-css-piece helmor-logo-css-piece-br"
				d="M646.615 828.14V602.047L860.126 715.089V941.174L646.615 828.14Z"
			/>
			<path
				className="helmor-logo-css-piece helmor-logo-css-piece-mr"
				d="M860.667 454.357L647.165 341.314V567.399L860.667 680.442V454.357Z"
			/>
			<path
				className="helmor-logo-css-piece helmor-logo-css-piece-tr"
				d="M646.615 306.673V80.582L860.126 193.625V419.709L646.615 306.673Z"
			/>
		</svg>
	);
}
