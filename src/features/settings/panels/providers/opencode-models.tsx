import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getOpencodeCustomProviders, listOpencodeModels } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	OPENCODE_CACHE_VERSION,
	type OpencodeCachedModel,
	type OpencodeProviderSettings,
	useSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ModelMultiSelect } from "./model-multi-select";

export type OpencodeModelsHandle = {
	/** `forceReload` restarts the opencode server first so newly-configured models show up. */
	refresh: (opts?: { forceReload?: boolean }) => void;
};

// Catalogs at/under this size enable every model by default. Larger ones only
// happen with env-injected models.dev keys (dev), so we trim to a curated set.
const DEFAULT_ENABLE_ALL_CAP = 12;

// Self-heal retry budget for the startup race (opencode connects config
// providers a few seconds after the server is "listening").
const SELF_HEAL_MAX_ATTEMPTS = 5;
const SELF_HEAL_RETRY_MS = 1500;

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

/** Configured provider ids absent from the cached model list — a sign opencode
 *  returned an incomplete list (custom providers not connected yet at fetch time). */
export function missingConfiguredProviders(
	cached: OpencodeCachedModel[],
	configuredProviderIds: ReadonlySet<string>,
): string[] {
	const present = new Set(cached.map((m) => m.slug.split("/")[0] ?? m.slug));
	return [...configuredProviderIds].filter((id) => !present.has(id));
}

export function OpencodeModels({
	ref,
}: {
	ref?: React.Ref<OpencodeModelsHandle>;
}) {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const opencode = settings.opencodeProvider;

	const persist = useCallback(
		async (patch: Partial<OpencodeProviderSettings>) => {
			await Promise.resolve(
				updateSettings({ opencodeProvider: { ...opencode, ...patch } }),
			);
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			});
		},
		[opencode, queryClient, updateSettings],
	);

	const fetchMutation = useMutation({
		mutationFn: (forceReload: boolean) => listOpencodeModels(forceReload),
		onSuccess: async (models) => {
			const cached: OpencodeCachedModel[] = models.map((m) => ({
				slug: m.id,
				label: m.label,
				...(m.effortLevels && m.effortLevels.length > 0
					? { effortLevels: m.effortLevels }
					: {}),
			}));
			// Connected provider IDs = unique slug prefixes.
			const connected = [
				...new Set(cached.map((m) => m.slug.split("/")[0] ?? m.slug)),
			];
			// Provider ids the user configured in their opencode config (custom +
			// presets) — their models are intentional and default to enabled.
			const configured = await getOpencodeCustomProviders().catch(() => []);
			const configuredIds = new Set(configured.map((p) => p.id));
			const enabledModelIds = reconcileEnabledModelIds(
				opencode.enabledModelIds,
				cached,
				opencode.cachedModels,
				configuredIds,
			);
			await persist({
				status: cached.length > 0 ? "ready" : "unavailable",
				connected,
				cachedModels: cached,
				enabledModelIds,
				cacheVersion: OPENCODE_CACHE_VERSION,
			});
		},
	});

	useImperativeHandle(
		ref,
		() => ({
			refresh: (opts?: { forceReload?: boolean }) =>
				fetchMutation.mutate(opts?.forceReload ?? false),
		}),
		[fetchMutation],
	);

	// Auto-fetch when no catalog yet or cache predates the current schema. Ref guards against re-firing within a mount.
	const autoFetchedRef = useRef(false);
	const cacheStale = (opencode.cacheVersion ?? 0) < OPENCODE_CACHE_VERSION;
	useEffect(() => {
		const needsFetch = opencode.cachedModels === null || cacheStale;
		if (needsFetch && !fetchMutation.isPending && !autoFetchedRef.current) {
			autoFetchedRef.current = true;
			fetchMutation.mutate(false);
		}
	}, [opencode.cachedModels, cacheStale, fetchMutation]);

	// Self-heal a startup race: opencode can return an incomplete model list
	// before it finishes connecting the config's custom providers. If a
	// configured provider is missing from the cache, refetch once (the server is
	// warm by now). Runs against the persisted cache too, so existing installs
	// heal as soon as this panel opens — no manual refresh needed.
	const customProvidersQuery = useQuery({
		queryKey: helmorQueryKeys.opencodeCustomProviders,
		queryFn: getOpencodeCustomProviders,
	});
	const selfHealAttemptsRef = useRef(0);
	useEffect(() => {
		if (fetchMutation.isPending) return;
		const cache = opencode.cachedModels;
		const configured = customProvidersQuery.data;
		if (!cache || !configured || configured.length === 0) return;
		const configuredIds = new Set(configured.map((p) => p.id));
		const missing = missingConfiguredProviders(cache, configuredIds).length > 0;
		if (!missing) {
			selfHealAttemptsRef.current = 0;
			return;
		}
		// opencode's ready/connect lags a few seconds after startup, so retry a
		// few times (warm — no server restart) until the providers show up.
		if (selfHealAttemptsRef.current >= SELF_HEAL_MAX_ATTEMPTS) return;
		selfHealAttemptsRef.current += 1;
		const timer = setTimeout(
			() => fetchMutation.mutate(false),
			SELF_HEAL_RETRY_MS,
		);
		return () => clearTimeout(timer);
	}, [opencode.cachedModels, customProvidersQuery.data, fetchMutation]);

	const cached = opencode.cachedModels ?? [];
	const available = useMemo(
		() => cached.map((m) => ({ id: m.slug, label: m.label })),
		[cached],
	);
	const enabledIds = opencode.enabledModelIds ?? [];
	const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);

	function toggle(id: string) {
		void persist({
			enabledModelIds: enabledSet.has(id)
				? enabledIds.filter((v) => v !== id)
				: [...enabledIds, id],
		});
	}

	return (
		<div className="flex w-full items-center gap-2">
			<ModelMultiSelect
				enabledIds={enabledIds}
				enabledSet={enabledSet}
				available={available}
				onToggle={toggle}
				loading={fetchMutation.isPending}
				triggerClassName="min-w-0 flex-1"
			/>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						aria-label="Refresh model list"
						disabled={fetchMutation.isPending}
						onClick={() => fetchMutation.mutate(false)}
					>
						<RefreshCcw
							className={cn(
								"size-3.5",
								fetchMutation.isPending && "animate-spin",
							)}
						/>
					</Button>
				</TooltipTrigger>
				<TooltipContent>Refresh models</TooltipContent>
			</Tooltip>
		</div>
	);
}
