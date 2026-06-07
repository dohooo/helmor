import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { listOpencodeModels } from "@/lib/api";
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

// Catalogs at/under this size enable every model by default; larger ones use the OpenCode Zen subset.
const DEFAULT_ENABLE_ALL_CAP = 12;

export function defaultEnabledSlugs(cached: OpencodeCachedModel[]): string[] {
	if (cached.length <= DEFAULT_ENABLE_ALL_CAP) {
		return cached.map((m) => m.slug);
	}
	const zen = cached
		.filter((m) => m.slug.startsWith("opencode/"))
		.map((m) => m.slug);
	if (zen.length > 0) return zen;
	return cached.slice(0, DEFAULT_ENABLE_ALL_CAP).map((m) => m.slug);
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
			// `null` → first fetch, auto-pick defaults. Else keep user picks, unless all are
			// stale (re-auth changed the set), then fall back to defaults. `[]` (user cleared) is kept.
			const prev = opencode.enabledModelIds;
			const cachedSlugs = new Set(cached.map((m) => m.slug));
			const staleNonEmpty =
				prev !== null &&
				prev.length > 0 &&
				!prev.some((s) => cachedSlugs.has(s));
			const enabledModelIds =
				prev === null || staleNonEmpty ? defaultEnabledSlugs(cached) : prev;
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
