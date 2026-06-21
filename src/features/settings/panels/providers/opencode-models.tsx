import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { stopAgentStream } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { activeStreamsQueryOptions, helmorQueryKeys } from "@/lib/query-client";
import {
	OPENCODE_CACHE_VERSION,
	type OpencodeProviderSettings,
	useSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ModelMultiSelect } from "./model-multi-select";
import type { SlugProviderAdapter } from "./slug-provider-adapter";
import { useSlugProviderModelSync } from "./use-opencode-model-sync";

export type SlugProviderModelsHandle = {
	/** `forceReload` restarts the provider's server first so newly-configured models show up. */
	refresh: (opts?: { forceReload?: boolean }) => void;
	/** Best-effort: restart + re-read config ONLY if no turn of this provider
	 *  is running, so a config save never interrupts active work (most of the
	 *  time it's idle). */
	syncIfIdle: () => void;
};

export function SlugProviderModels({
	adapter,
	ref,
}: {
	adapter: SlugProviderAdapter;
	ref?: React.Ref<SlugProviderModelsHandle>;
}) {
	const { f } = useI18n();
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const current = settings[adapter.settingsKey];
	const { sync, isSyncing } = useSlugProviderModelSync(adapter);

	const persist = useCallback(
		async (patch: Partial<OpencodeProviderSettings>) => {
			await Promise.resolve(
				updateSettings({ [adapter.settingsKey]: { ...current, ...patch } }),
			);
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			});
		},
		[adapter.settingsKey, current, queryClient, updateSettings],
	);

	// Syncing restarts the provider's server, which interrupts its in-flight
	// turns — stop them cleanly first so the restart doesn't strand them in a
	// "running" state, and confirm before doing so from the manual button.
	const activeStreamsQuery = useQuery(activeStreamsQueryOptions());
	const runningStreams = useMemo(
		() =>
			(activeStreamsQuery.data ?? []).filter(
				(s) => s.provider === adapter.provider,
			),
		[activeStreamsQuery.data, adapter.provider],
	);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const reloadSync = useCallback(async () => {
		await Promise.allSettled(
			runningStreams.map((s) => stopAgentStream(s.sessionId, adapter.provider)),
		);
		await sync({ forceReload: true });
	}, [runningStreams, adapter.provider, sync]);

	const onSyncClick = useCallback(() => {
		if (runningStreams.length > 0) {
			setConfirmOpen(true);
			return;
		}
		void reloadSync();
	}, [runningStreams.length, reloadSync]);

	useImperativeHandle(
		ref,
		() => ({
			refresh: (opts?: { forceReload?: boolean }) => {
				if (opts?.forceReload) void reloadSync();
				else void sync();
			},
			syncIfIdle: () => {
				if (runningStreams.length === 0) void sync({ forceReload: true });
			},
		}),
		[reloadSync, sync, runningStreams.length],
	);

	// Auto-fetch when no catalog yet or cache predates the current schema. Ref guards against re-firing within a mount.
	const autoFetchedRef = useRef(false);
	const cacheStale = (current.cacheVersion ?? 0) < OPENCODE_CACHE_VERSION;
	useEffect(() => {
		const needsFetch = current.cachedModels === null || cacheStale;
		if (needsFetch && !isSyncing && !autoFetchedRef.current) {
			autoFetchedRef.current = true;
			void sync();
		}
	}, [current.cachedModels, cacheStale, isSyncing, sync]);

	const cached = current.cachedModels ?? [];
	const available = useMemo(
		() => cached.map((m) => ({ id: m.slug, label: m.label })),
		[cached],
	);
	const enabledIds = current.enabledModelIds ?? [];
	const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);

	function toggle(id: string) {
		void persist({
			enabledModelIds: enabledSet.has(id)
				? enabledIds.filter((v) => v !== id)
				: [...enabledIds, id],
		});
	}

	function clearAll() {
		void persist({ enabledModelIds: [] });
	}

	const runningCount = runningStreams.length;

	return (
		<div className="flex w-full items-center gap-2">
			<ModelMultiSelect
				enabledIds={enabledIds}
				enabledSet={enabledSet}
				available={available}
				onToggle={toggle}
				onClear={clearAll}
				loading={isSyncing}
				triggerClassName="min-w-0 flex-1"
			/>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						aria-label="syncModels"
						disabled={isSyncing}
						onClick={onSyncClick}
					>
						<RefreshCcw
							className={cn("size-3.5", isSyncing && "animate-spin")}
						/>
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{f("syncModelsReReadsPath", {
						path: adapter.configPathLabel,
					})}
				</TooltipContent>
			</Tooltip>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={(open) => {
					if (!isSyncing) setConfirmOpen(open);
				}}
				title={f("syncNameModels", { name: adapter.displayName })}
				description={
					runningCount === 1
						? f("reReadingConfigRestartsNameWill", {
								name: adapter.displayName,
							})
						: f("reReadingConfigRestartsNameWill2", {
								name: adapter.displayName,
								count: runningCount,
							})
				}
				confirmLabel="syncAnyway"
				onConfirm={() => {
					void reloadSync().finally(() => setConfirmOpen(false));
				}}
				loading={isSyncing}
			/>
		</div>
	);
}
