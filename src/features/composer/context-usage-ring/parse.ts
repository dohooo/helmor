// Display-ready parsing for context usage and per-provider rate limits.
// Percentages are only trusted when the stored model matches the composer.

/** Baseline: written at turn end by both Claude and Codex. */
export type StoredContextUsageMeta = {
	readonly modelId: string;
	readonly usedTokens: number;
	readonly maxTokens: number;
	readonly percentage: number;
};

/** Claude-only breakdown fetched live on hover. */
export type ClaudeRichContextUsage = StoredContextUsageMeta & {
	readonly isAutoCompactEnabled: boolean;
	readonly categories: ReadonlyArray<{ name: string; tokens: number }>;
};

/** <60 default, 60–80 warning, >=80 danger. */
export type RingTier = "default" | "warning" | "danger";

export function ringTier(percentage: number): RingTier {
	if (percentage >= 80) return "danger";
	if (percentage >= 60) return "warning";
	return "default";
}

/** Ring display state. */
export type DisplayResolution =
	| { readonly kind: "empty" }
	| {
			readonly kind: "tokensOnly";
			readonly recordedModelId: string;
			readonly usedTokens: number;
	  }
	| {
			readonly kind: "full";
			readonly modelId: string;
			readonly usedTokens: number;
			readonly maxTokens: number;
			readonly percentage: number;
			readonly tier: RingTier;
			readonly rich: ClaudeRichContextUsage | null;
	  };

/** Rich overrides baseline; model mismatches degrade to tokens-only. */
export function resolveContextUsageDisplay(
	baseline: StoredContextUsageMeta | null,
	rich: ClaudeRichContextUsage | null,
	composerModelId: string | null,
): DisplayResolution {
	const effective = rich ?? baseline;
	if (!effective) return { kind: "empty" };

	const matches =
		composerModelId === null || effective.modelId === composerModelId;
	if (!matches) {
		return {
			kind: "tokensOnly",
			recordedModelId: effective.modelId,
			usedTokens: effective.usedTokens,
		};
	}

	return {
		kind: "full",
		modelId: effective.modelId,
		usedTokens: effective.usedTokens,
		maxTokens: effective.maxTokens,
		percentage: effective.percentage,
		tier: ringTier(effective.percentage),
		rich,
	};
}

// ── JSON parsers ───────────────────────────────────────────────────────

type Json = unknown;

function asNumber(v: Json): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asObject(v: Json): Record<string, Json> | null {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, Json>)
		: null;
}

function clampPercent(used: number, max: number): number {
	if (max <= 0) return 0;
	return Math.min(100, Math.max(0, (used / max) * 100));
}

export function parseStoredMeta(
	json: string | null | undefined,
): StoredContextUsageMeta | null {
	if (!json) return null;
	let parsed: Json;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const root = asObject(parsed);
	if (!root) return null;
	const used = asNumber(root.usedTokens);
	const max = asNumber(root.maxTokens);
	if (used === null || max === null) return null;
	return {
		modelId: typeof root.modelId === "string" ? root.modelId : "",
		usedTokens: used,
		maxTokens: max,
		percentage: asNumber(root.percentage) ?? clampPercent(used, max),
	};
}

export function parseClaudeRichMeta(
	json: string | null | undefined,
): ClaudeRichContextUsage | null {
	if (!json) return null;
	let parsed: Json;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const root = asObject(parsed);
	if (!root) return null;
	const used = asNumber(root.usedTokens);
	const max = asNumber(root.maxTokens);
	if (used === null || max === null) return null;
	const rawCategories = Array.isArray(root.categories) ? root.categories : [];
	const categories: Array<{ name: string; tokens: number }> = [];
	for (const entry of rawCategories) {
		const obj = asObject(entry);
		if (!obj) continue;
		const name = typeof obj.name === "string" ? obj.name : null;
		const tokens = asNumber(obj.tokens);
		if (!name || tokens === null) continue;
		categories.push({ name, tokens });
	}
	return {
		modelId: typeof root.modelId === "string" ? root.modelId : "",
		usedTokens: used,
		maxTokens: max,
		percentage: asNumber(root.percentage) ?? clampPercent(used, max),
		isAutoCompactEnabled: root.isAutoCompactEnabled === true,
		categories,
	};
}

// ── Formatting helpers ────────────────────────────────────────────────

/** "12.4k" / "1.0M" / "0". */
export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

// ── Rate limits (orthogonal to context meta) ───────────────────────────

export type RateLimitWindowDisplay = {
	usedPercent: number;
	leftPercent: number;
	label: string | null;
	resetsAt: number | null;
	expired: boolean;
};

export type RateLimitSnapshotDisplay = {
	primary: RateLimitWindowDisplay | null;
	secondary: RateLimitWindowDisplay | null;
	extraWindows: ReadonlyArray<{
		id: string;
		title: string;
		window: RateLimitWindowDisplay;
	}>;
	/** Metadata-only rows shown beneath the windows (Plan, Credits, …). */
	notes: ReadonlyArray<{ label: string; value: string }>;
};

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

/** Parse Codex's raw `wham/usage` body. Falls back to the legacy CLI
 *  push shape (`primary` / `secondary` already camelCase) so a stale
 *  cache from before the OAuth migration still renders something. */
export function parseCodexRateLimits(
	value: Json | null | undefined,
	now: number = Date.now() / 1000,
): RateLimitSnapshotDisplay | null {
	const root = readJsonObject(value);
	if (!root) return null;

	const rateLimit = asObject(root.rate_limit) ?? asObject(root.rateLimit);
	let primary = parseChatGptWindow(asObject(rateLimit?.primary_window), now);
	let secondary = parseChatGptWindow(
		asObject(rateLimit?.secondary_window),
		now,
	);
	// Fall back to the old CLI push shape — primary/secondary at the root
	// in camelCase. Only used to render a cache leftover gracefully; the
	// next active fetch overwrites the body in this shape.
	if (!primary) primary = parseCamelWindow(asObject(root.primary), now);
	if (!secondary) secondary = parseCamelWindow(asObject(root.secondary), now);

	const extraWindows = parseCamelExtraWindows(root.extraWindows, now);
	const notes = parseCodexNotes(root);
	if (
		!primary &&
		!secondary &&
		extraWindows.length === 0 &&
		notes.length === 0
	) {
		return null;
	}
	return { primary, secondary, extraWindows, notes };
}

function parseCodexNotes(
	root: Record<string, Json>,
): RateLimitSnapshotDisplay["notes"] {
	const notes: Array<{ label: string; value: string }> = [];

	const planRaw = root.plan_type ?? root.planType;
	const planLabel = formatCodexPlan(planRaw);
	if (planLabel) notes.push({ label: "Plan", value: planLabel });

	const credits = asObject(root.credits);
	if (credits) {
		const unlimited = credits.unlimited === true;
		const hasCredits =
			credits.has_credits === true || credits.hasCredits === true;
		if (unlimited) {
			notes.push({ label: "Credits", value: "Unlimited" });
		} else {
			const balance = parseCreditsBalance(credits.balance);
			if (balance !== null) {
				notes.push({ label: "Credits", value: formatCredits(balance) });
			} else if (hasCredits === false) {
				notes.push({ label: "Credits", value: "0.00" });
			}
		}
	}

	return notes;
}

function parseCreditsBalance(value: Json): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function formatCredits(balance: number): string {
	const safe = Math.max(0, balance);
	return safe.toFixed(2);
}

function formatCodexPlan(value: Json): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed
		.split(/[_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}

function parseChatGptWindow(
	obj: Record<string, Json> | null,
	now: number,
): RateLimitWindowDisplay | null {
	if (!obj) return null;
	const used = asNumber(obj.used_percent);
	if (used === null) return null;
	const seconds = asNumber(obj.limit_window_seconds);
	const minutes = seconds !== null && seconds > 0 ? seconds / 60 : null;
	const resetsAt = asNumber(obj.reset_at);
	return buildWindow(used, minutes, resetsAt, now);
}

/** Parse Anthropic's raw `/api/oauth/usage` body. Fields stay snake_case
 *  on the wire — we map them here, not in Rust, so adding a new window
 *  upstream only takes a parser tweak (no DB migration). */
export function parseClaudeRateLimits(
	value: Json | null | undefined,
	now: number = Date.now() / 1000,
): RateLimitSnapshotDisplay | null {
	const root = readJsonObject(value);
	if (!root) return null;
	const primary = parseAnthropicWindow(
		asObject(root.five_hour),
		FIVE_HOUR_MINUTES,
		now,
	);
	const secondary = parseAnthropicWindow(
		asObject(root.seven_day),
		SEVEN_DAY_MINUTES,
		now,
	);
	const extraWindows: Array<{
		id: string;
		title: string;
		window: RateLimitWindowDisplay;
	}> = [];
	for (const [key, raw] of Object.entries(root)) {
		const suffix = claudeExtraSuffix(key);
		if (!suffix) continue;
		const window = parseAnthropicWindow(asObject(raw), SEVEN_DAY_MINUTES, now);
		if (!window) continue;
		extraWindows.push({
			id: `claude-${suffix.replace(/_/g, "-")}`,
			title: humanizeClaudeSuffix(suffix),
			window,
		});
	}
	extraWindows.sort((a, b) => a.id.localeCompare(b.id));
	if (!primary && !secondary && extraWindows.length === 0) return null;
	return { primary, secondary, extraWindows, notes: [] };
}

function readJsonObject(
	value: Json | null | undefined,
): Record<string, Json> | null {
	if (!value) return null;
	let parsed: Json;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return null;
		}
	} else {
		parsed = value;
	}
	return asObject(parsed);
}

function parseCamelExtraWindows(
	value: Json,
	now: number,
): RateLimitSnapshotDisplay["extraWindows"] {
	if (!Array.isArray(value)) return [];
	const windows: Array<{
		id: string;
		title: string;
		window: RateLimitWindowDisplay;
	}> = [];
	for (const entry of value) {
		const obj = asObject(entry);
		if (!obj) continue;
		const id = typeof obj.id === "string" ? obj.id : null;
		const title = typeof obj.title === "string" ? obj.title : null;
		const window = parseCamelWindow(asObject(obj.window), now);
		if (!id || !title || !window) continue;
		windows.push({ id, title, window });
	}
	return windows;
}

function parseCamelWindow(
	obj: Record<string, Json> | null,
	now: number,
): RateLimitWindowDisplay | null {
	if (!obj) return null;
	const used = asNumber(obj.usedPercent);
	if (used === null) return null;
	const minutes = asNumber(obj.windowDurationMins);
	const resetsAt = asNumber(obj.resetsAt);
	return buildWindow(used, minutes, resetsAt, now);
}

function parseAnthropicWindow(
	obj: Record<string, Json> | null,
	minutes: number,
	now: number,
): RateLimitWindowDisplay | null {
	if (!obj) return null;
	const used = asNumber(obj.utilization);
	if (used === null) return null;
	const resetsAt = parseAnthropicResetsAt(obj.resets_at);
	return buildWindow(used, minutes, resetsAt, now);
}

function buildWindow(
	used: number,
	minutes: number | null,
	resetsAt: number | null,
	now: number,
): RateLimitWindowDisplay {
	const usedClamped = Math.max(0, Math.min(100, used));
	return {
		usedPercent: usedClamped,
		leftPercent: 100 - usedClamped,
		label: formatWindowLabel(minutes),
		resetsAt,
		expired: resetsAt !== null && resetsAt < now,
	};
}

function parseAnthropicResetsAt(value: Json): number | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function claudeExtraSuffix(key: string): string | null {
	if (!key.startsWith("seven_day_")) return null;
	return key.slice("seven_day_".length);
}

function humanizeClaudeSuffix(suffix: string): string {
	if (suffix === "sonnet") return "Sonnet";
	if (suffix === "opus") return "Opus";
	if (suffix === "omelette") return "Designs";
	if (suffix === "cowork") return "Daily Routines";
	return suffix
		.split("_")
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function formatWindowLabel(minutes: number | null): string | null {
	if (minutes === null || minutes <= 0) return null;
	if (minutes % (60 * 24) === 0) return `${minutes / 60 / 24}d limit`;
	if (minutes % 60 === 0) return `${minutes / 60}h limit`;
	return `${minutes}m limit`;
}

/** Format a unix-seconds timestamp like "Apr 23, 1:29 PM". */
export function formatResetsAt(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
