import {
	type AnimationEvent,
	type CSSProperties,
	type ForwardedRef,
	forwardRef,
	type MutableRefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { generateBeamCSS, sizePresets, sizeThemePresets } from "./styles";
import type { BorderBeamProps, BorderBeamTheme } from "./types";

function useSystemTheme(): "dark" | "light" {
	const [theme, setTheme] = useState<"dark" | "light">(() => {
		if (typeof window === "undefined") return "dark";
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	});

	useEffect(() => {
		if (typeof window === "undefined") return;

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (e: MediaQueryListEvent) => {
			setTheme(e.matches ? "dark" : "light");
		};

		mediaQuery.addEventListener("change", handler);
		return () => mediaQuery.removeEventListener("change", handler);
	}, []);

	return theme;
}

function resolveTheme(
	theme: BorderBeamTheme,
	systemTheme: "dark" | "light",
): "dark" | "light" {
	return theme === "auto" ? systemTheme : theme;
}

/**
 * BorderBeam component - Animated border beam effect for React
 *
 * @example
 * ```tsx
 * <BorderBeam>
 *   <Card>Content</Card>
 * </BorderBeam>
 * ```
 */
export const BorderBeam = forwardRef<HTMLDivElement, BorderBeamProps>(
	function BorderBeam(
		{
			children,
			size = "md",
			side = "all",
			travelDirection = "normal",
			colorVariant = "colorful",
			theme = "dark",
			staticColors = false,
			duration,
			active = true,
			borderRadius: customBorderRadius,
			brightness = 1.3,
			saturation,
			hueRange = 30,
			strength = 1,
			className,
			style,
			onActivate,
			onDeactivate,
			onAnimationEnd: consumerOnAnimationEnd,
			...props
		}: BorderBeamProps,
		ref: ForwardedRef<HTMLDivElement>,
	) {
		const baseId = useId();
		const id = baseId.replace(/:/g, "-");
		const systemTheme = useSystemTheme();
		const internalRef = useRef<HTMLDivElement>(null);

		const [isActive, setIsActive] = useState(active);
		const [isFading, setIsFading] = useState(false);
		const [detectedRadius, setDetectedRadius] = useState<number | null>(null);

		// Auto-detect child border radius when no explicit value is provided
		useEffect(() => {
			if (customBorderRadius != null) return;
			const el = internalRef.current;
			if (!el) return;

			const detect = () => {
				const child = el.firstElementChild as HTMLElement | null;
				if (!child) return;
				const computed = getComputedStyle(child);
				const raw = parseFloat(computed.borderTopLeftRadius);
				if (!Number.isNaN(raw) && raw > 0) {
					setDetectedRadius(raw);
				}
			};

			detect();

			// Re-detect if child layout changes (e.g. CSS loaded late)
			const observer = new MutationObserver(detect);
			observer.observe(el, { childList: true, subtree: false });
			return () => observer.disconnect();
		}, [customBorderRadius, children]);

		useEffect(() => {
			if (active && !isActive && !isFading) {
				setIsActive(true);
			} else if (!active && isActive && !isFading) {
				setIsFading(true);
			}
		}, [active, isActive, isFading]);

		const handleAnimationEnd = useCallback(
			(e: AnimationEvent<HTMLDivElement>) => {
				const animationName = e.animationName;

				if (animationName.includes("fade-out")) {
					setIsActive(false);
					setIsFading(false);
					onDeactivate?.();
				} else if (animationName.includes("fade-in")) {
					onActivate?.();
				}

				consumerOnAnimationEnd?.(e);
			},
			[onActivate, onDeactivate, consumerOnAnimationEnd],
		);

		const resolvedTheme = resolveTheme(theme, systemTheme);
		const effectiveSize = side === "all" ? size : "line";
		const themeConfig = sizeThemePresets[effectiveSize][resolvedTheme];
		const sizeConfig = sizePresets[effectiveSize];

		const finalBorderRadius =
			customBorderRadius ?? detectedRadius ?? sizeConfig.borderRadius;
		const finalDuration = duration ?? (effectiveSize === "line" ? 2.4 : 1.96);
		const finalSaturation = saturation ?? themeConfig.saturation;
		const finalHueRange =
			effectiveSize === "line" ? Math.min(hueRange, 13) : hueRange;
		const finalStaticColors = colorVariant === "mono" ? true : staticColors;

		const cssStyles = useMemo(
			() =>
				generateBeamCSS({
					id,
					borderRadius: finalBorderRadius,
					borderWidth: sizeConfig.borderWidth,
					duration: finalDuration,
					strokeOpacity: themeConfig.strokeOpacity,
					innerOpacity: themeConfig.innerOpacity,
					bloomOpacity: themeConfig.bloomOpacity,
					innerShadow: themeConfig.innerShadow,
					size: effectiveSize,
					side,
					travelDirection,
					colorVariant,
					staticColors: finalStaticColors,
					brightness,
					saturation: finalSaturation,
					hueRange: finalHueRange,
					theme: resolvedTheme,
				}),
			[
				id,
				finalBorderRadius,
				sizeConfig.borderWidth,
				finalDuration,
				themeConfig.strokeOpacity,
				themeConfig.innerOpacity,
				themeConfig.bloomOpacity,
				themeConfig.innerShadow,
				effectiveSize,
				side,
				travelDirection,
				colorVariant,
				finalStaticColors,
				brightness,
				finalSaturation,
				finalHueRange,
				resolvedTheme,
			],
		);

		const setRefs = useCallback(
			(node: HTMLDivElement | null) => {
				(internalRef as MutableRefObject<HTMLDivElement | null>).current = node;
				if (typeof ref === "function") {
					ref(node);
				} else if (ref) {
					(ref as MutableRefObject<HTMLDivElement | null>).current = node;
				}
			},
			[ref],
		);

		const mergedStyle = {
			...(style ?? {}),
			"--beam-strength": Math.max(0, Math.min(1, strength)),
		} as CSSProperties;

		return (
			<>
				<style>{cssStyles}</style>
				<div
					{...props}
					ref={setRefs}
					data-beam={id}
					data-active={isActive && !isFading ? "" : undefined}
					data-fading={isFading ? "" : undefined}
					className={className}
					style={mergedStyle}
					onAnimationEnd={handleAnimationEnd}
				>
					{children}
					<div data-beam-bloom />
				</div>
			</>
		);
	},
);

export default BorderBeam;
