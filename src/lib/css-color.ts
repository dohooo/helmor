let cssColorProbe: HTMLDivElement | null = null;
let cssColorCanvas: CanvasRenderingContext2D | null = null;
let unsupportedColorSentinel: CanvasGradient | null = null;

// Memoize resolved colors; invalidate on every `<html>` class change.
const cssColorCache = new Map<string, string>();

export function invalidateCssColorCache(): void {
	cssColorCache.clear();
}

function getCssColorProbe(): HTMLDivElement {
	if (!cssColorProbe) {
		cssColorProbe = document.createElement("div");
		cssColorProbe.style.cssText =
			"position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;";
		(document.body ?? document.documentElement).appendChild(cssColorProbe);
	}
	return cssColorProbe;
}

function getCssColorCanvas(): CanvasRenderingContext2D {
	if (!cssColorCanvas) {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) {
			throw new Error("Failed to get 2D context for color resolver");
		}
		ctx.globalCompositeOperation = "copy";
		cssColorCanvas = ctx;
		unsupportedColorSentinel = ctx.createLinearGradient(0, 0, 1, 1);
	}
	return cssColorCanvas;
}

function toHexByte(n: number): string {
	return Math.max(0, Math.min(255, Math.round(n)))
		.toString(16)
		.padStart(2, "0");
}

export function resolveCssColor(value: string, alphaOverride?: number): string {
	const cacheKey = `${value}::${alphaOverride ?? ""}`;
	const hit = cssColorCache.get(cacheKey);
	if (hit !== undefined) return hit;

	const probe = getCssColorProbe();
	probe.style.backgroundColor = "";
	probe.style.backgroundColor = value;
	if (!probe.style.backgroundColor) {
		throw new Error(`Unsupported CSS color: ${value}`);
	}
	const computed = getComputedStyle(probe).backgroundColor;

	const ctx = getCssColorCanvas();
	const sentinel = unsupportedColorSentinel;
	if (!sentinel) {
		throw new Error("Color resolver sentinel was not initialized");
	}
	ctx.fillStyle = sentinel;
	ctx.fillStyle = computed;
	if (typeof ctx.fillStyle !== "string") {
		throw new Error(`Unsupported CSS color: ${value}`);
	}

	ctx.clearRect(0, 0, 1, 1);
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b, baseAlpha] = ctx.getImageData(0, 0, 1, 1).data;
	const alpha =
		alphaOverride === undefined ? baseAlpha : Math.round(alphaOverride * 255);
	const alphaHex = alpha >= 255 ? "" : toHexByte(alpha);

	const result = `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}${alphaHex}`;
	cssColorCache.set(cacheKey, result);
	return result;
}
