// Context-usage meta builders — one shape for both providers.
//
// Written into `sessions.context_usage_meta` at turn end. `modelId`
// lets the frontend hide stale percentages after a model switch.

export type StoredContextUsageMeta = {
	/** Empty only for legacy rows or unknown callers. */
	readonly modelId: string;
	readonly usedTokens: number;
	readonly maxTokens: number;
	readonly percentage: number;
};

/** Claude-only hover breakdown. Adds categories + auto-compact to the
 *  baseline shape. Fetched live on hover via `getContextUsage` RPC. */
export type ClaudeRichContextUsage = StoredContextUsageMeta & {
	readonly isAutoCompactEnabled: boolean;
	readonly categories: ReadonlyArray<{ name: string; tokens: number }>;
};

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function computePercentage(used: number, max: number): number {
	if (max <= 0) return 0;
	const raw = Math.min(100, Math.max(0, (used / max) * 100));
	return Math.round(raw * 100) / 100;
}

function matchesClaudeUsage(
	entry: Record<string, unknown>,
	usage: Record<string, unknown>,
): boolean {
	return (
		num(entry.inputTokens) === num(usage.input_tokens) &&
		num(entry.outputTokens) === num(usage.output_tokens) &&
		num(entry.cacheCreationInputTokens) ===
			num(usage.cache_creation_input_tokens) &&
		num(entry.cacheReadInputTokens) === num(usage.cache_read_input_tokens)
	);
}

function selectClaudeModelUsage(
	modelUsage: Record<string, Record<string, unknown>>,
	usage: Record<string, unknown>,
	modelId: string,
): Record<string, unknown> | null {
	const direct = modelId ? modelUsage[modelId] : undefined;
	if (direct) return direct;

	const matching = Object.values(modelUsage).filter((entry) =>
		matchesClaudeUsage(entry, usage),
	);
	const [matched] = matching;
	if (matching.length === 1 && matched) return matched;

	const entries = Object.values(modelUsage);
	const [only] = entries;
	return entries.length === 1 && only ? only : null;
}

/**
 * Persisted meta from a Claude terminal `result` (success or error).
 * Returns null when usage data is missing.
 *
 * Tokens come from `iterations[last]`, not top-level `usage` — `usage`
 * is a cumulative per-call counter and overshoots the window on
 * tool-heavy turns. See SDK's `BetaIterationsUsage` docs.
 */
export function buildClaudeStoredMeta(
	result: unknown,
	modelId: string,
): StoredContextUsageMeta | null {
	const root = (result ?? {}) as Record<string, unknown>;
	const usage = (root.usage ?? null) as Record<string, unknown> | null;
	const modelUsage = (root.modelUsage ?? null) as Record<
		string,
		Record<string, unknown>
	> | null;
	if (!usage || !modelUsage) return null;

	const source =
		pickLastMessageIteration(usage.iterations) ??
		pickLastMessageIteration(root.iterations) ??
		usage;
	const used =
		num(source.input_tokens) +
		num(source.cache_creation_input_tokens) +
		num(source.cache_read_input_tokens) +
		num(source.output_tokens);

	const selectedUsage = selectClaudeModelUsage(modelUsage, usage, modelId);
	const max = num(selectedUsage?.contextWindow);
	if (max <= 0 || used <= 0) return null;

	const usedClamped = Math.min(used, max);
	return {
		modelId,
		usedTokens: usedClamped,
		maxTokens: max,
		percentage: computePercentage(usedClamped, max),
	};
}

// Last `message` iteration, skipping trailing compaction entries.
function pickLastMessageIteration(
	raw: unknown,
): Record<string, unknown> | null {
	if (!Array.isArray(raw)) return null;
	for (let i = raw.length - 1; i >= 0; i--) {
		const entry = raw[i];
		if (!entry || typeof entry !== "object") continue;
		const obj = entry as Record<string, unknown>;
		const t = obj.type;
		if (typeof t === "string" && t !== "message") continue;
		return obj;
	}
	return null;
}

/**
 * Reduce `SDKControlGetContextUsageResponse` to the rich shape for the
 * hover popover. Filters the "Free space" pseudo-category.
 */
export function buildClaudeRichMeta(
	raw: unknown,
	modelId: string,
): ClaudeRichContextUsage {
	const root = (raw ?? {}) as Record<string, unknown>;
	const rawCategories = Array.isArray(root.categories) ? root.categories : [];
	const used = num(root.totalTokens);
	const max = num(root.maxTokens);
	const sdkPct = num(root.percentage);
	const percentage =
		sdkPct > 0 ? Math.round(sdkPct * 100) / 100 : computePercentage(used, max);
	return {
		modelId,
		usedTokens: used,
		maxTokens: max,
		percentage,
		isAutoCompactEnabled: root.isAutoCompactEnabled === true,
		categories: rawCategories
			.filter((entry): entry is { name: string; tokens: number } => {
				if (!entry || typeof entry !== "object") return false;
				const e = entry as { name?: unknown; tokens?: unknown };
				return (
					typeof e.name === "string" &&
					e.name !== "Free space" &&
					typeof e.tokens === "number"
				);
			})
			.map(({ name, tokens }) => ({ name, tokens })),
	};
}

/**
 * Build the persisted meta from a Codex `thread/tokenUsage/updated`
 * payload. `usedTokens` = `last.totalTokens` (context fill for the
 * most recent turn, not the cumulative billing counter). `maxTokens` =
 * `modelContextWindow`. Codex notifications don't carry a model id, so
 * the caller stamps the active turn's model id.
 */
export function buildCodexStoredMeta(
	tokenUsage: unknown,
	modelId: string,
): StoredContextUsageMeta | null {
	const root = (tokenUsage ?? {}) as Record<string, unknown>;
	const last = (root.last ?? null) as Record<string, unknown> | null;
	const total = (root.total ?? null) as Record<string, unknown> | null;
	const max = num(root.modelContextWindow);
	const used = num(last?.totalTokens ?? total?.totalTokens);
	if (used <= 0 && max <= 0) return null;

	const usedClamped = max > 0 ? Math.min(used, max) : used;
	return {
		modelId,
		usedTokens: usedClamped,
		maxTokens: max,
		percentage: computePercentage(usedClamped, max),
	};
}
