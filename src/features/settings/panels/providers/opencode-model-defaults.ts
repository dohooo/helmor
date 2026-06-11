import type { OpencodeCachedModel } from "@/lib/settings";

// Catalogs at/under this size enable every model by default. Larger ones only
// happen with env-injected models.dev keys (dev), so we trim to a curated set.
const DEFAULT_ENABLE_ALL_CAP = 12;

const providerOf = (slug: string): string => slug.split("/")[0] ?? "";

/** A model is "intentional" if it's a free OpenCode Zen model or comes from a
 *  provider the user configured in their opencode config (custom / preset). */
function isIntentional(
	slug: string,
	configuredProviderIds: ReadonlySet<string>,
): boolean {
	const id = providerOf(slug);
	return id === "opencode" || configuredProviderIds.has(id);
}

export function defaultEnabledSlugs(
	cached: OpencodeCachedModel[],
	configuredProviderIds: ReadonlySet<string> = new Set(),
): string[] {
	if (cached.length <= DEFAULT_ENABLE_ALL_CAP) {
		return cached.map((m) => m.slug);
	}
	// Big catalog: keep Zen + every model from a provider the user configured,
	// so custom providers are never excluded by default (the env-injected bulk is).
	const curated = cached
		.map((m) => m.slug)
		.filter((slug) => isIntentional(slug, configuredProviderIds));
	if (curated.length > 0) return curated;
	return cached.slice(0, DEFAULT_ENABLE_ALL_CAP).map((m) => m.slug);
}

/** Decide which model slugs stay enabled after a refresh.
 *  - `null` (first fetch) or all picks stale → fall back to defaults.
 *  - `[]` (user cleared everything) → respected, stays empty.
 *  - otherwise keep the user's picks AND auto-enable intentional models that
 *    newly appeared since the last snapshot (e.g. a just-added custom provider). */
export function reconcileEnabledModelIds(
	prev: string[] | null,
	cached: OpencodeCachedModel[],
	prevCachedModels: OpencodeCachedModel[] | null,
	configuredProviderIds: ReadonlySet<string> = new Set(),
): string[] {
	const cachedSlugs = new Set(cached.map((m) => m.slug));
	const staleNonEmpty =
		prev !== null && prev.length > 0 && !prev.some((s) => cachedSlugs.has(s));
	if (prev === null || staleNonEmpty)
		return defaultEnabledSlugs(cached, configuredProviderIds);
	if (prev.length === 0) return prev;
	const prevCached = new Set((prevCachedModels ?? []).map((m) => m.slug));
	const newly = cached
		.map((m) => m.slug)
		.filter(
			(s) =>
				!prevCached.has(s) &&
				!prev.includes(s) &&
				isIntentional(s, configuredProviderIds),
		);
	return newly.length > 0 ? [...prev, ...newly] : prev;
}
