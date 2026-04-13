import lottie from "lottie-web/build/player/lottie_svg";
import { useEffect, useMemo, useRef } from "react";
import logoAnimation from "@/assets/helmor-logo-animation.json";
import { resolveTheme, useSettings } from "@/lib/settings";

// The original animation has a ~1.7s hold between flip cascades and
// 0.6s dead frames at the end. Compress keyframe timing so the loop
// feels continuous: shrink the gap between cascades from ~100 frames
// to 20, and trim trailing dead frames.
const HOLD_GAP = 76; // frames between first and second cascade
const TAIL_PAD = 6; // frames after last keyframe before loop restarts

function compressKeyframes(data: Record<string, unknown>) {
	// Collect all shape layers and find their two cascade regions
	for (const layer of (data as { layers: Array<Record<string, unknown>> })
		.layers) {
		if ((layer as { ty: number }).ty !== 4) continue;
		const ks = layer.ks as Record<string, unknown>;
		for (const prop of Object.values(ks)) {
			const p = prop as { a?: number; k?: Array<{ t: number }> };
			if (!p || p.a !== 1 || !Array.isArray(p.k)) continue;
			const kfs = p.k;
			// Split keyframes into first cascade (t <= 80) and second (t > 80)
			const first = kfs.filter((kf) => kf.t <= 80);
			const second = kfs.filter((kf) => kf.t > 80);
			if (second.length === 0) continue;
			// Find where first cascade ends and second starts
			const firstEnd = Math.max(...first.map((kf) => kf.t));
			const secondStart = Math.min(...second.map((kf) => kf.t));
			const shift = secondStart - firstEnd - HOLD_GAP;
			if (shift <= 0) continue;
			// Shift second cascade earlier
			for (const kf of second) {
				kf.t -= shift;
			}
		}
	}
	// Find new last keyframe and set out point
	let lastKf = 0;
	for (const layer of (data as { layers: Array<Record<string, unknown>> })
		.layers) {
		const ks = layer.ks as Record<string, unknown> | undefined;
		if (!ks) continue;
		for (const prop of Object.values(ks)) {
			const p = prop as { a?: number; k?: Array<{ t: number }> };
			if (!p || p.a !== 1 || !Array.isArray(p.k)) continue;
			for (const kf of p.k) {
				if (kf.t > lastKf) lastKf = kf.t;
			}
		}
	}
	(data as { op: number }).op = lastKf + TAIL_PAD;
}

// Deep-clone the animation JSON, compress timing, swap colours per theme.
// Background layer is always transparent (container provides bg).
function themedAnimationData(theme: "light" | "dark") {
	const data = JSON.parse(JSON.stringify(logoAnimation));
	compressKeyframes(data);

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
