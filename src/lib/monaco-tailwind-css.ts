// Resolves Tailwind class names to their generated CSS for hover previews
// and completion documentation. No worker, no compiler — just a deterministic
// mapping over the default Tailwind vocabulary.
//
// Returns null for arbitrary values (`w-[42px]`), repo-harvested custom
// classes, and anything outside the default palette/scale. Variant prefixes
// (`hover:`, `sm:`, `dark:`, ...) are stripped before resolution.
//
// Color values are the Tailwind v3 default palette in hex. v4 uses oklch
// internally but the visual mapping is essentially identical for hover docs.

const SPACING_FRACTION_MAP: Record<string, string> = {
	"1/2": "50%",
	"1/3": "33.333333%",
	"2/3": "66.666667%",
	"1/4": "25%",
	"2/4": "50%",
	"3/4": "75%",
	"1/5": "20%",
	"2/5": "40%",
	"3/5": "60%",
	"4/5": "80%",
	"1/6": "16.666667%",
	"5/6": "83.333333%",
	"1/12": "8.333333%",
	"11/12": "91.666667%",
};

function spacingValueToCss(value: string): string | null {
	if (value === "px") return "1px";
	if (value === "0") return "0px";
	if (value === "auto") return "auto";
	if (value === "full") return "100%";
	if (value === "min") return "min-content";
	if (value === "max") return "max-content";
	if (value === "fit") return "fit-content";
	const fraction = SPACING_FRACTION_MAP[value];
	if (fraction) return fraction;
	const num = Number.parseFloat(value);
	if (Number.isNaN(num)) return null;
	const rem = num * 0.25;
	return `${rem}rem`;
}

const SPACING_PROPERTY_MAP: Record<string, string[]> = {
	p: ["padding"],
	px: ["padding-left", "padding-right"],
	py: ["padding-top", "padding-bottom"],
	pt: ["padding-top"],
	pr: ["padding-right"],
	pb: ["padding-bottom"],
	pl: ["padding-left"],
	ps: ["padding-inline-start"],
	pe: ["padding-inline-end"],
	m: ["margin"],
	mx: ["margin-left", "margin-right"],
	my: ["margin-top", "margin-bottom"],
	mt: ["margin-top"],
	mr: ["margin-right"],
	mb: ["margin-bottom"],
	ml: ["margin-left"],
	ms: ["margin-inline-start"],
	me: ["margin-inline-end"],
	gap: ["gap"],
	"gap-x": ["column-gap"],
	"gap-y": ["row-gap"],
	inset: ["inset"],
	"inset-x": ["left", "right"],
	"inset-y": ["top", "bottom"],
	top: ["top"],
	right: ["right"],
	bottom: ["bottom"],
	left: ["left"],
	start: ["inset-inline-start"],
	end: ["inset-inline-end"],
};

const SIZING_PROPERTY_MAP: Record<string, string[]> = {
	w: ["width"],
	h: ["height"],
	"min-w": ["min-width"],
	"min-h": ["min-height"],
	"max-w": ["max-width"],
	"max-h": ["max-height"],
	size: ["width", "height"],
};

const MAX_WIDTH_NAMED: Record<string, string> = {
	none: "none",
	xs: "20rem",
	sm: "24rem",
	md: "28rem",
	lg: "32rem",
	xl: "36rem",
	"2xl": "42rem",
	"3xl": "48rem",
	"4xl": "56rem",
	"5xl": "64rem",
	"6xl": "72rem",
	"7xl": "80rem",
	prose: "65ch",
	"screen-sm": "640px",
	"screen-md": "768px",
	"screen-lg": "1024px",
	"screen-xl": "1280px",
	"screen-2xl": "1536px",
};

const TEXT_SIZE_MAP: Record<string, [size: string, lineHeight: string]> = {
	xs: ["0.75rem", "1rem"],
	sm: ["0.875rem", "1.25rem"],
	base: ["1rem", "1.5rem"],
	lg: ["1.125rem", "1.75rem"],
	xl: ["1.25rem", "1.75rem"],
	"2xl": ["1.5rem", "2rem"],
	"3xl": ["1.875rem", "2.25rem"],
	"4xl": ["2.25rem", "2.5rem"],
	"5xl": ["3rem", "1"],
	"6xl": ["3.75rem", "1"],
	"7xl": ["4.5rem", "1"],
	"8xl": ["6rem", "1"],
	"9xl": ["8rem", "1"],
};

const FONT_WEIGHT_MAP: Record<string, string> = {
	thin: "100",
	extralight: "200",
	light: "300",
	normal: "400",
	medium: "500",
	semibold: "600",
	bold: "700",
	extrabold: "800",
	black: "900",
};

const FONT_FAMILY_MAP: Record<string, string> = {
	sans: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
	serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
	mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

const TRACKING_MAP: Record<string, string> = {
	tighter: "-0.05em",
	tight: "-0.025em",
	normal: "0em",
	wide: "0.025em",
	wider: "0.05em",
	widest: "0.1em",
};

const LEADING_NAMED: Record<string, string> = {
	none: "1",
	tight: "1.25",
	snug: "1.375",
	normal: "1.5",
	relaxed: "1.625",
	loose: "2",
};

const RADIUS_MAP: Record<string, string> = {
	"": "0.25rem",
	none: "0px",
	sm: "0.125rem",
	md: "0.375rem",
	lg: "0.5rem",
	xl: "0.75rem",
	"2xl": "1rem",
	"3xl": "1.5rem",
	full: "9999px",
};

const SHADOW_MAP: Record<string, string> = {
	"": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
	sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
	md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
	lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
	xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
	"2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
	inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
	none: "0 0 #0000",
};

const COLOR_PROPERTY_MAP: Record<string, string> = {
	bg: "background-color",
	text: "color",
	border: "border-color",
	ring: "--tw-ring-color",
	"ring-offset": "--tw-ring-offset-color",
	fill: "fill",
	stroke: "stroke",
	outline: "outline-color",
	decoration: "text-decoration-color",
	placeholder: "color",
	accent: "accent-color",
	caret: "caret-color",
	divide: "border-color",
	shadow: "--tw-shadow-color",
	from: "--tw-gradient-from",
	via: "--tw-gradient-via",
	to: "--tw-gradient-to",
};

const SPECIAL_COLOR_CSS: Record<string, string> = {
	transparent: "transparent",
	current: "currentColor",
	inherit: "inherit",
	black: "#000",
	white: "#fff",
};

// Tailwind v3 default palette. Values from
// https://tailwindcss.com/docs/customizing-colors (v3.4 defaults).
const COLOR_HEX: Record<string, Record<string, string>> = {
	slate: {
		50: "#f8fafc",
		100: "#f1f5f9",
		200: "#e2e8f0",
		300: "#cbd5e1",
		400: "#94a3b8",
		500: "#64748b",
		600: "#475569",
		700: "#334155",
		800: "#1e293b",
		900: "#0f172a",
		950: "#020617",
	},
	gray: {
		50: "#f9fafb",
		100: "#f3f4f6",
		200: "#e5e7eb",
		300: "#d1d5db",
		400: "#9ca3af",
		500: "#6b7280",
		600: "#4b5563",
		700: "#374151",
		800: "#1f2937",
		900: "#111827",
		950: "#030712",
	},
	zinc: {
		50: "#fafafa",
		100: "#f4f4f5",
		200: "#e4e4e7",
		300: "#d4d4d8",
		400: "#a1a1aa",
		500: "#71717a",
		600: "#52525b",
		700: "#3f3f46",
		800: "#27272a",
		900: "#18181b",
		950: "#09090b",
	},
	neutral: {
		50: "#fafafa",
		100: "#f5f5f5",
		200: "#e5e5e5",
		300: "#d4d4d4",
		400: "#a3a3a3",
		500: "#737373",
		600: "#525252",
		700: "#404040",
		800: "#262626",
		900: "#171717",
		950: "#0a0a0a",
	},
	stone: {
		50: "#fafaf9",
		100: "#f5f5f4",
		200: "#e7e5e4",
		300: "#d6d3d1",
		400: "#a8a29e",
		500: "#78716c",
		600: "#57534e",
		700: "#44403c",
		800: "#292524",
		900: "#1c1917",
		950: "#0c0a09",
	},
	red: {
		50: "#fef2f2",
		100: "#fee2e2",
		200: "#fecaca",
		300: "#fca5a5",
		400: "#f87171",
		500: "#ef4444",
		600: "#dc2626",
		700: "#b91c1c",
		800: "#991b1b",
		900: "#7f1d1d",
		950: "#450a0a",
	},
	orange: {
		50: "#fff7ed",
		100: "#ffedd5",
		200: "#fed7aa",
		300: "#fdba74",
		400: "#fb923c",
		500: "#f97316",
		600: "#ea580c",
		700: "#c2410c",
		800: "#9a3412",
		900: "#7c2d12",
		950: "#431407",
	},
	amber: {
		50: "#fffbeb",
		100: "#fef3c7",
		200: "#fde68a",
		300: "#fcd34d",
		400: "#fbbf24",
		500: "#f59e0b",
		600: "#d97706",
		700: "#b45309",
		800: "#92400e",
		900: "#78350f",
		950: "#451a03",
	},
	yellow: {
		50: "#fefce8",
		100: "#fef9c3",
		200: "#fef08a",
		300: "#fde047",
		400: "#facc15",
		500: "#eab308",
		600: "#ca8a04",
		700: "#a16207",
		800: "#854d0e",
		900: "#713f12",
		950: "#422006",
	},
	lime: {
		50: "#f7fee7",
		100: "#ecfccb",
		200: "#d9f99d",
		300: "#bef264",
		400: "#a3e635",
		500: "#84cc16",
		600: "#65a30d",
		700: "#4d7c0f",
		800: "#3f6212",
		900: "#365314",
		950: "#1a2e05",
	},
	green: {
		50: "#f0fdf4",
		100: "#dcfce7",
		200: "#bbf7d0",
		300: "#86efac",
		400: "#4ade80",
		500: "#22c55e",
		600: "#16a34a",
		700: "#15803d",
		800: "#166534",
		900: "#14532d",
		950: "#052e16",
	},
	emerald: {
		50: "#ecfdf5",
		100: "#d1fae5",
		200: "#a7f3d0",
		300: "#6ee7b7",
		400: "#34d399",
		500: "#10b981",
		600: "#059669",
		700: "#047857",
		800: "#065f46",
		900: "#064e3b",
		950: "#022c22",
	},
	teal: {
		50: "#f0fdfa",
		100: "#ccfbf1",
		200: "#99f6e4",
		300: "#5eead4",
		400: "#2dd4bf",
		500: "#14b8a6",
		600: "#0d9488",
		700: "#0f766e",
		800: "#115e59",
		900: "#134e4a",
		950: "#042f2e",
	},
	cyan: {
		50: "#ecfeff",
		100: "#cffafe",
		200: "#a5f3fc",
		300: "#67e8f9",
		400: "#22d3ee",
		500: "#06b6d4",
		600: "#0891b2",
		700: "#0e7490",
		800: "#155e75",
		900: "#164e63",
		950: "#083344",
	},
	sky: {
		50: "#f0f9ff",
		100: "#e0f2fe",
		200: "#bae6fd",
		300: "#7dd3fc",
		400: "#38bdf8",
		500: "#0ea5e9",
		600: "#0284c7",
		700: "#0369a1",
		800: "#075985",
		900: "#0c4a6e",
		950: "#082f49",
	},
	blue: {
		50: "#eff6ff",
		100: "#dbeafe",
		200: "#bfdbfe",
		300: "#93c5fd",
		400: "#60a5fa",
		500: "#3b82f6",
		600: "#2563eb",
		700: "#1d4ed8",
		800: "#1e40af",
		900: "#1e3a8a",
		950: "#172554",
	},
	indigo: {
		50: "#eef2ff",
		100: "#e0e7ff",
		200: "#c7d2fe",
		300: "#a5b4fc",
		400: "#818cf8",
		500: "#6366f1",
		600: "#4f46e5",
		700: "#4338ca",
		800: "#3730a3",
		900: "#312e81",
		950: "#1e1b4b",
	},
	violet: {
		50: "#f5f3ff",
		100: "#ede9fe",
		200: "#ddd6fe",
		300: "#c4b5fd",
		400: "#a78bfa",
		500: "#8b5cf6",
		600: "#7c3aed",
		700: "#6d28d9",
		800: "#5b21b6",
		900: "#4c1d95",
		950: "#2e1065",
	},
	purple: {
		50: "#faf5ff",
		100: "#f3e8ff",
		200: "#e9d5ff",
		300: "#d8b4fe",
		400: "#c084fc",
		500: "#a855f7",
		600: "#9333ea",
		700: "#7e22ce",
		800: "#6b21a8",
		900: "#581c87",
		950: "#3b0764",
	},
	fuchsia: {
		50: "#fdf4ff",
		100: "#fae8ff",
		200: "#f5d0fe",
		300: "#f0abfc",
		400: "#e879f9",
		500: "#d946ef",
		600: "#c026d3",
		700: "#a21caf",
		800: "#86198f",
		900: "#701a75",
		950: "#4a044e",
	},
	pink: {
		50: "#fdf2f8",
		100: "#fce7f3",
		200: "#fbcfe8",
		300: "#f9a8d4",
		400: "#f472b6",
		500: "#ec4899",
		600: "#db2777",
		700: "#be185d",
		800: "#9d174d",
		900: "#831843",
		950: "#500724",
	},
	rose: {
		50: "#fff1f2",
		100: "#ffe4e6",
		200: "#fecdd3",
		300: "#fda4af",
		400: "#fb7185",
		500: "#f43f5e",
		600: "#e11d48",
		700: "#be123c",
		800: "#9f1239",
		900: "#881337",
		950: "#4c0519",
	},
};

const STATIC_CSS: Record<string, string> = {
	// Display
	block: "display: block;",
	"inline-block": "display: inline-block;",
	inline: "display: inline;",
	flex: "display: flex;",
	"inline-flex": "display: inline-flex;",
	grid: "display: grid;",
	"inline-grid": "display: inline-grid;",
	contents: "display: contents;",
	hidden: "display: none;",
	table: "display: table;",
	"table-row": "display: table-row;",
	"table-cell": "display: table-cell;",
	"flow-root": "display: flow-root;",
	"list-item": "display: list-item;",
	// Position
	absolute: "position: absolute;",
	relative: "position: relative;",
	fixed: "position: fixed;",
	sticky: "position: sticky;",
	static: "position: static;",
	// Flex direction / wrap / shorthand
	"flex-row": "flex-direction: row;",
	"flex-row-reverse": "flex-direction: row-reverse;",
	"flex-col": "flex-direction: column;",
	"flex-col-reverse": "flex-direction: column-reverse;",
	"flex-wrap": "flex-wrap: wrap;",
	"flex-nowrap": "flex-wrap: nowrap;",
	"flex-wrap-reverse": "flex-wrap: wrap-reverse;",
	"flex-1": "flex: 1 1 0%;",
	"flex-auto": "flex: 1 1 auto;",
	"flex-initial": "flex: 0 1 auto;",
	"flex-none": "flex: none;",
	grow: "flex-grow: 1;",
	"grow-0": "flex-grow: 0;",
	shrink: "flex-shrink: 1;",
	"shrink-0": "flex-shrink: 0;",
	"basis-auto": "flex-basis: auto;",
	"basis-full": "flex-basis: 100%;",
	"basis-0": "flex-basis: 0px;",
	// Align / justify
	"items-start": "align-items: flex-start;",
	"items-end": "align-items: flex-end;",
	"items-center": "align-items: center;",
	"items-baseline": "align-items: baseline;",
	"items-stretch": "align-items: stretch;",
	"justify-start": "justify-content: flex-start;",
	"justify-end": "justify-content: flex-end;",
	"justify-center": "justify-content: center;",
	"justify-between": "justify-content: space-between;",
	"justify-around": "justify-content: space-around;",
	"justify-evenly": "justify-content: space-evenly;",
	"self-auto": "align-self: auto;",
	"self-start": "align-self: flex-start;",
	"self-end": "align-self: flex-end;",
	"self-center": "align-self: center;",
	"self-stretch": "align-self: stretch;",
	"self-baseline": "align-self: baseline;",
	"content-start": "align-content: flex-start;",
	"content-end": "align-content: flex-end;",
	"content-center": "align-content: center;",
	"content-between": "align-content: space-between;",
	"content-around": "align-content: space-around;",
	"content-evenly": "align-content: space-evenly;",
	// Text alignment / decoration / transform
	"text-left": "text-align: left;",
	"text-center": "text-align: center;",
	"text-right": "text-align: right;",
	"text-justify": "text-align: justify;",
	"text-start": "text-align: start;",
	"text-end": "text-align: end;",
	italic: "font-style: italic;",
	"not-italic": "font-style: normal;",
	underline: "text-decoration-line: underline;",
	"line-through": "text-decoration-line: line-through;",
	"no-underline": "text-decoration-line: none;",
	overline: "text-decoration-line: overline;",
	uppercase: "text-transform: uppercase;",
	lowercase: "text-transform: lowercase;",
	capitalize: "text-transform: capitalize;",
	"normal-case": "text-transform: none;",
	truncate: "overflow: hidden;\ntext-overflow: ellipsis;\nwhite-space: nowrap;",
	"text-ellipsis": "text-overflow: ellipsis;",
	"text-clip": "text-overflow: clip;",
	// Whitespace / wrap
	"whitespace-normal": "white-space: normal;",
	"whitespace-nowrap": "white-space: nowrap;",
	"whitespace-pre": "white-space: pre;",
	"whitespace-pre-line": "white-space: pre-line;",
	"whitespace-pre-wrap": "white-space: pre-wrap;",
	"whitespace-break-spaces": "white-space: break-spaces;",
	"break-normal": "overflow-wrap: normal;\nword-break: normal;",
	"break-words": "overflow-wrap: break-word;",
	"break-all": "word-break: break-all;",
	"break-keep": "word-break: keep-all;",
	// Cursor / interactivity
	"cursor-auto": "cursor: auto;",
	"cursor-default": "cursor: default;",
	"cursor-pointer": "cursor: pointer;",
	"cursor-wait": "cursor: wait;",
	"cursor-text": "cursor: text;",
	"cursor-move": "cursor: move;",
	"cursor-help": "cursor: help;",
	"cursor-not-allowed": "cursor: not-allowed;",
	"cursor-grab": "cursor: grab;",
	"cursor-grabbing": "cursor: grabbing;",
	"select-none": "user-select: none;",
	"select-text": "user-select: text;",
	"select-all": "user-select: all;",
	"select-auto": "user-select: auto;",
	"pointer-events-none": "pointer-events: none;",
	"pointer-events-auto": "pointer-events: auto;",
	"appearance-none": "appearance: none;",
	"appearance-auto": "appearance: auto;",
	"resize-none": "resize: none;",
	"resize-y": "resize: vertical;",
	"resize-x": "resize: horizontal;",
	resize: "resize: both;",
	// Object / aspect
	"object-contain": "object-fit: contain;",
	"object-cover": "object-fit: cover;",
	"object-fill": "object-fit: fill;",
	"object-none": "object-fit: none;",
	"object-scale-down": "object-fit: scale-down;",
	"aspect-auto": "aspect-ratio: auto;",
	"aspect-square": "aspect-ratio: 1 / 1;",
	"aspect-video": "aspect-ratio: 16 / 9;",
	// Isolation
	isolate: "isolation: isolate;",
	"isolation-auto": "isolation: auto;",
	// Transition prefabs
	"transition-none": "transition-property: none;",
	transition:
		"transition-property: color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter;\ntransition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);\ntransition-duration: 150ms;",
	"transition-all": "transition-property: all;",
	"transition-colors":
		"transition-property: color, background-color, border-color, text-decoration-color, fill, stroke;",
	"transition-opacity": "transition-property: opacity;",
	"transition-shadow": "transition-property: box-shadow;",
	"transition-transform": "transition-property: transform;",
	"ease-linear": "transition-timing-function: linear;",
	"ease-in": "transition-timing-function: cubic-bezier(0.4, 0, 1, 1);",
	"ease-out": "transition-timing-function: cubic-bezier(0, 0, 0.2, 1);",
	"ease-in-out": "transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);",
	// Animation
	"animate-none": "animation: none;",
	"animate-spin": "animation: spin 1s linear infinite;",
	"animate-ping": "animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;",
	"animate-pulse": "animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;",
	"animate-bounce": "animation: bounce 1s infinite;",
	// Border style
	"border-solid": "border-style: solid;",
	"border-dashed": "border-style: dashed;",
	"border-dotted": "border-style: dotted;",
	"border-double": "border-style: double;",
	"border-none": "border-style: none;",
	"border-hidden": "border-style: hidden;",
	// Accessibility
	"sr-only":
		"position: absolute;\nwidth: 1px;\nheight: 1px;\npadding: 0;\nmargin: -1px;\noverflow: hidden;\nclip: rect(0, 0, 0, 0);\nwhite-space: nowrap;\nborder-width: 0;",
	"not-sr-only":
		"position: static;\nwidth: auto;\nheight: auto;\npadding: 0;\nmargin: 0;\noverflow: visible;\nclip: auto;\nwhite-space: normal;",
	// Misc
	"bg-none": "background-image: none;",
	"list-none": "list-style-type: none;",
	"list-disc": "list-style-type: disc;",
	"list-decimal": "list-style-type: decimal;",
	"list-inside": "list-style-position: inside;",
	"list-outside": "list-style-position: outside;",
};

const ROUNDED_CORNER_MAP: Record<string, string[]> = {
	t: ["border-top-left-radius", "border-top-right-radius"],
	r: ["border-top-right-radius", "border-bottom-right-radius"],
	b: ["border-bottom-right-radius", "border-bottom-left-radius"],
	l: ["border-top-left-radius", "border-bottom-left-radius"],
	tl: ["border-top-left-radius"],
	tr: ["border-top-right-radius"],
	br: ["border-bottom-right-radius"],
	bl: ["border-bottom-left-radius"],
	s: ["border-start-start-radius", "border-end-start-radius"],
	e: ["border-start-end-radius", "border-end-end-radius"],
	ss: ["border-start-start-radius"],
	se: ["border-start-end-radius"],
	es: ["border-end-start-radius"],
	ee: ["border-end-end-radius"],
};

const BORDER_SIDE_MAP: Record<string, string[]> = {
	t: ["border-top-width"],
	r: ["border-right-width"],
	b: ["border-bottom-width"],
	l: ["border-left-width"],
	x: ["border-left-width", "border-right-width"],
	y: ["border-top-width", "border-bottom-width"],
};

function joinDecls(properties: string[], value: string): string {
	return properties.map((p) => `${p}: ${value};`).join("\n");
}

function stripVariants(input: string): string {
	const idx = input.lastIndexOf(":");
	return idx >= 0 ? input.slice(idx + 1) : input;
}

export type ResolvedCss = {
	css: string;
	colorHex?: string;
};

export function resolveTailwindCss(input: string): ResolvedCss | null {
	const cls = stripVariants(input);
	if (cls.length === 0) return null;

	const direct = STATIC_CSS[cls];
	if (direct) return { css: direct };

	const negative = cls.startsWith("-");
	const positive = negative ? cls.slice(1) : cls;

	// Spacing utilities (padding, margin, gap, inset, top/right/bottom/left)
	for (const prefix of Object.keys(SPACING_PROPERTY_MAP)) {
		if (!positive.startsWith(`${prefix}-`)) continue;
		const value = positive.slice(prefix.length + 1);
		const v = spacingValueToCss(value);
		if (v == null) continue;
		const final = negative && v !== "auto" ? `-${v}` : v;
		return { css: joinDecls(SPACING_PROPERTY_MAP[prefix], final) };
	}

	// Sizing utilities
	for (const prefix of Object.keys(SIZING_PROPERTY_MAP)) {
		if (!positive.startsWith(`${prefix}-`)) continue;
		const value = positive.slice(prefix.length + 1);
		let v: string | null = null;
		if (value === "screen") {
			v =
				prefix === "h" || prefix === "min-h" || prefix === "max-h"
					? "100vh"
					: "100vw";
		} else {
			v = spacingValueToCss(value);
			if (v == null && prefix === "max-w") {
				v = MAX_WIDTH_NAMED[value] ?? null;
			}
		}
		if (v == null) continue;
		return { css: joinDecls(SIZING_PROPERTY_MAP[prefix], v) };
	}

	// Typography
	if (positive.startsWith("text-")) {
		const rest = positive.slice(5);
		const t = TEXT_SIZE_MAP[rest];
		if (t) return { css: `font-size: ${t[0]};\nline-height: ${t[1]};` };
	}
	if (positive.startsWith("font-")) {
		const rest = positive.slice(5);
		const w = FONT_WEIGHT_MAP[rest];
		if (w) return { css: `font-weight: ${w};` };
		const family = FONT_FAMILY_MAP[rest];
		if (family) return { css: `font-family: ${family};` };
	}
	if (positive.startsWith("tracking-")) {
		const v = TRACKING_MAP[positive.slice(9)];
		if (v) return { css: `letter-spacing: ${v};` };
	}
	if (positive.startsWith("leading-")) {
		const rest = positive.slice(8);
		const named = LEADING_NAMED[rest];
		if (named) return { css: `line-height: ${named};` };
		const num = Number.parseFloat(rest);
		if (!Number.isNaN(num)) {
			return { css: `line-height: ${num * 0.25}rem;` };
		}
	}

	// Border radius
	const radiusMatch = positive.match(
		/^rounded(?:-(t|r|b|l|tl|tr|bl|br|s|e|ss|se|es|ee))?(?:-(.+))?$/,
	);
	if (radiusMatch) {
		const corner = radiusMatch[1];
		const size = radiusMatch[2] ?? "";
		const v = RADIUS_MAP[size];
		if (v != null) {
			if (!corner) return { css: `border-radius: ${v};` };
			const props = ROUNDED_CORNER_MAP[corner];
			if (props) return { css: joinDecls(props, v) };
		}
	}

	// Border width: border, border-N, border-{side}, border-{side}-N
	const borderWidthMatch = positive.match(
		/^border(?:-(t|r|b|l|x|y))?(?:-(\d+))?$/,
	);
	if (borderWidthMatch) {
		const side = borderWidthMatch[1];
		const width = borderWidthMatch[2] ?? "1";
		const value = `${width}px`;
		if (!side) return { css: `border-width: ${value};` };
		const props = BORDER_SIDE_MAP[side];
		if (props) return { css: joinDecls(props, value) };
	}

	// Box shadow
	const shadowMatch = positive.match(/^shadow(?:-(.+))?$/);
	if (shadowMatch) {
		const size = shadowMatch[1] ?? "";
		const v = SHADOW_MAP[size];
		if (v) return { css: `box-shadow: ${v};` };
	}

	// Opacity
	const opacityMatch = positive.match(/^opacity-(\d+)$/);
	if (opacityMatch) {
		const num = Number(opacityMatch[1]);
		return { css: `opacity: ${num / 100};` };
	}

	// Z-index
	const zMatch = positive.match(/^z-(.+)$/);
	if (zMatch) {
		if (zMatch[1] === "auto") return { css: "z-index: auto;" };
		const num = Number(zMatch[1]);
		if (!Number.isNaN(num)) return { css: `z-index: ${num};` };
	}

	// Transition duration / delay
	const durMatch = positive.match(/^duration-(\d+)$/);
	if (durMatch) return { css: `transition-duration: ${durMatch[1]}ms;` };
	const delayMatch = positive.match(/^delay-(\d+)$/);
	if (delayMatch) return { css: `transition-delay: ${delayMatch[1]}ms;` };

	// Ring width
	const ringMatch = positive.match(/^ring(?:-(\d+|inset))?$/);
	if (ringMatch) {
		const v = ringMatch[1];
		if (!v) {
			return {
				css: "box-shadow: 0 0 0 3px var(--tw-ring-color, rgb(59 130 246 / 0.5));",
			};
		}
		if (v === "inset") return { css: "--tw-ring-inset: inset;" };
		return {
			css: `box-shadow: 0 0 0 ${v}px var(--tw-ring-color, rgb(59 130 246 / 0.5));`,
		};
	}

	// Grid templates / spans
	const gridColsMatch = positive.match(/^grid-cols-(\d+)$/);
	if (gridColsMatch) {
		return {
			css: `grid-template-columns: repeat(${gridColsMatch[1]}, minmax(0, 1fr));`,
		};
	}
	const gridRowsMatch = positive.match(/^grid-rows-(\d+)$/);
	if (gridRowsMatch) {
		return {
			css: `grid-template-rows: repeat(${gridRowsMatch[1]}, minmax(0, 1fr));`,
		};
	}
	const colSpanMatch = positive.match(/^col-span-(\d+|full)$/);
	if (colSpanMatch) {
		return colSpanMatch[1] === "full"
			? { css: "grid-column: 1 / -1;" }
			: {
					css: `grid-column: span ${colSpanMatch[1]} / span ${colSpanMatch[1]};`,
				};
	}
	const rowSpanMatch = positive.match(/^row-span-(\d+|full)$/);
	if (rowSpanMatch) {
		return rowSpanMatch[1] === "full"
			? { css: "grid-row: 1 / -1;" }
			: {
					css: `grid-row: span ${rowSpanMatch[1]} / span ${rowSpanMatch[1]};`,
				};
	}

	// Color utilities
	for (const prefix of Object.keys(COLOR_PROPERTY_MAP)) {
		if (!positive.startsWith(`${prefix}-`)) continue;
		const rest = positive.slice(prefix.length + 1);
		const property = COLOR_PROPERTY_MAP[prefix];
		const special = SPECIAL_COLOR_CSS[rest];
		if (special) {
			return {
				css: `${property}: ${special};`,
				colorHex:
					rest === "black"
						? "#000000"
						: rest === "white"
							? "#ffffff"
							: undefined,
			};
		}
		const colorShade = rest.match(/^([a-z]+)-(\d+)$/);
		if (colorShade) {
			const [, color, shade] = colorShade;
			const hex = COLOR_HEX[color]?.[shade];
			if (hex) return { css: `${property}: ${hex};`, colorHex: hex };
		}
	}

	return null;
}
