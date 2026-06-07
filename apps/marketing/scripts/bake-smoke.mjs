// Bakes the hero's 3 smoke plumes into transparent WebP rasters.
//
// WHY: the plumes were live SVG feTurbulence + feDisplacementMap filters. Three
// of them, full-stage, animated with scale() + mix-blend-mode, forced the
// browser to recompute the (expensive) turbulence raster every single frame —
// the marketing page's main source of jank. The turbulence isn't even animated
// (no SMIL), so the per-frame recompute produced a visually STATIC result. We
// bake that result once and let the page drift/parallax cheap GPU transforms.
//
// USAGE (from repo root — playwright + sharp are root devDeps):
//   bun apps/marketing/scripts/bake-smoke.mjs
//
// Output -> apps/marketing/public/smoke/plume-{back,mid,front}.webp
// Wired up in apps/marketing/app/marketing.css (.plume-* .smoke-swirl).
//
// The SVG markup below is the ORIGINAL plume markup (previously inline in
// marketing-shell.tsx), JSX prop names converted to SVG attribute names. To
// restyle the smoke, edit the SVGs here and re-run. viewBox 800x600 is 4:3, so
// rendering into a 4:3 box makes preserveAspectRatio slice == meet (no crop);
// the page re-applies the original slice with `background-size: cover`.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../public/smoke");
// 4:3 to match the 800x600 viewBox. 1600x1200 = 2x — the smoke is low-frequency
// and blurs further under motion, so this upscales cleanly on large displays.
const W = 1600;
const H = 1200;
const QUALITY = 74;

const plumes = {
	back: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" width="${W}" height="${H}">
  <defs>
    <filter id="turb-back" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.008 0.014" numOctaves="3" seed="3" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="90" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <radialGradient id="grad-back" cx="72%" cy="50%" r="55%">
      <stop offset="0%" stop-color="oklch(0.95 0.05 245)" stop-opacity="1"/>
      <stop offset="30%" stop-color="oklch(0.75 0.12 250)" stop-opacity="0.85"/>
      <stop offset="60%" stop-color="oklch(0.50 0.13 258)" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="oklch(0.25 0.08 265)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g filter="url(#turb-back)">
    <ellipse cx="560" cy="280" rx="320" ry="230" fill="url(#grad-back)"/>
    <ellipse cx="420" cy="350" rx="260" ry="190" fill="url(#grad-back)" opacity="0.85"/>
    <ellipse cx="620" cy="420" rx="220" ry="160" fill="url(#grad-back)" opacity="0.75"/>
    <ellipse cx="300" cy="290" rx="180" ry="140" fill="url(#grad-back)" opacity="0.6"/>
    <ellipse cx="500" cy="170" rx="200" ry="130" fill="url(#grad-back)" opacity="0.65"/>
  </g>
</svg>`,
	mid: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" width="${W}" height="${H}">
  <defs>
    <filter id="turb-mid" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.028" numOctaves="4" seed="7" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="65" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <radialGradient id="grad-mid" cx="70%" cy="48%" r="50%">
      <stop offset="0%" stop-color="oklch(0.98 0.03 245)" stop-opacity="1"/>
      <stop offset="25%" stop-color="oklch(0.85 0.09 245)" stop-opacity="0.9"/>
      <stop offset="55%" stop-color="oklch(0.58 0.13 252)" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="oklch(0.28 0.08 258)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g filter="url(#turb-mid)">
    <ellipse cx="540" cy="300" rx="240" ry="180" fill="url(#grad-mid)"/>
    <ellipse cx="420" cy="220" rx="170" ry="130" fill="url(#grad-mid)" opacity="0.85"/>
    <ellipse cx="600" cy="390" rx="190" ry="140" fill="url(#grad-mid)" opacity="0.85"/>
    <ellipse cx="340" cy="380" rx="150" ry="110" fill="url(#grad-mid)" opacity="0.75"/>
    <ellipse cx="260" cy="260" rx="130" ry="100" fill="url(#grad-mid)" opacity="0.55"/>
  </g>
</svg>`,
	front: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" width="${W}" height="${H}">
  <defs>
    <filter id="turb-front" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.035 0.050" numOctaves="5" seed="11" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="45" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <radialGradient id="grad-front" cx="68%" cy="45%" r="42%">
      <stop offset="0%" stop-color="oklch(1 0 0)" stop-opacity="1"/>
      <stop offset="20%" stop-color="oklch(0.93 0.05 245)" stop-opacity="0.95"/>
      <stop offset="50%" stop-color="oklch(0.68 0.12 250)" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="oklch(0.32 0.09 255)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g filter="url(#turb-front)">
    <ellipse cx="520" cy="290" rx="180" ry="140" fill="url(#grad-front)"/>
    <ellipse cx="400" cy="340" rx="130" ry="100" fill="url(#grad-front)" opacity="0.85"/>
    <ellipse cx="580" cy="360" rx="140" ry="105" fill="url(#grad-front)" opacity="0.8"/>
    <ellipse cx="460" cy="200" rx="110" ry="85" fill="url(#grad-front)" opacity="0.75"/>
    <ellipse cx="300" cy="280" rx="100" ry="75" fill="url(#grad-front)" opacity="0.55"/>
  </g>
</svg>`,
};

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
	viewport: { width: W, height: H },
	deviceScaleFactor: 1,
});

for (const [name, svg] of Object.entries(plumes)) {
	await page.setContent(
		`<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:transparent}
      svg{display:block}
    </style></head><body>${svg}</body></html>`,
		{ waitUntil: "networkidle" },
	);
	await page.waitForTimeout(150); // let the filter rasterize before capture
	const png = await page.locator("svg").screenshot({ omitBackground: true });
	const out = join(OUT_DIR, `plume-${name}.webp`);
	const info = await sharp(png).webp({ quality: QUALITY }).toFile(out);
	console.log(
		`plume-${name}.webp  ${info.width}x${info.height}  ${(info.size / 1024).toFixed(1)} KB`,
	);
}

await browser.close();
console.log("done ->", OUT_DIR);
