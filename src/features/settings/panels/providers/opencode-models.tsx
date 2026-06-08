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
import { activeStreamsQueryOptions, helmorQueryKeys } from "@/lib/query-client";
import {
	OPENCODE_CACHE_VERSION,
	type OpencodeProviderSettings,
	useSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ModelMultiSelect } from "./model-multi-select";
import { useOpencodeModelSync } from "./use-opencode-model-sync";

export type OpencodeModelsHandle = {
	/** `forceReload` restarts the opencode server first so newly-configured models show up. */
	refresh: (opts?: { forceReload?: boolean }) => void;
	/** Best-effort: restart + re-read config ONLY if no opencode turn is running,
	 *  so a config save never interrupts active work (most of the time it's idle). */
	syncIfIdle: () => void;
};

export function OpencodeModels({
	ref,
}: {
	ref?: React.Ref<OpencodeModelsHandle>;
}) {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const opencode = settings.opencodeProvider;
	const { sync, isSyncing } = useOpencodeModelSync();

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

	// Syncing restarts `opencode serve`, which interrupts in-flight opencode
	// turns — stop them cleanly first so the restart doesn't strand them in a
	// "running" state, and confirm before doing so from the manual button.
	const activeStreamsQuery = useQuery(activeStreamsQueryOptions());
	const runningOpencode = useMemo(
		() =>
			(activeStreamsQuery.data ?? []).filter((s) => s.provider === "opencode"),
		[activeStreamsQuery.data],
	);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const reloadSync = useCallback(async () => {
		await Promise.allSettled(
			runningOpencode.map((s) => stopAgentStream(s.sessionId, "opencode")),
		);
		await sync({ forceReload: true });
	}, [runningOpencode, sync]);

	const onSyncClick = useCallback(() => {
		if (runningOpencode.length > 0) {
			setConfirmOpen(true);
			return;
		}
		void reloadSync();
	}, [runningOpencode.length, reloadSync]);

	useImperativeHandle(
		ref,
		() => ({
			refresh: (opts?: { forceReload?: boolean }) => {
				if (opts?.forceReload) void reloadSync();
				else void sync();
			},
			syncIfIdle: () => {
				if (runningOpencode.length === 0) void sync({ forceReload: true });
			},
		}),
		[reloadSync, sync, runningOpencode.length],
	);

	// Auto-fetch when no catalog yet or cache predates the current schema. Ref guards against re-firing within a mount.
	const autoFetchedRef = useRef(false);
	const cacheStale = (opencode.cacheVersion ?? 0) < OPENCODE_CACHE_VERSION;
	useEffect(() => {
		const needsFetch = opencode.cachedModels === null || cacheStale;
		if (needsFetch && !isSyncing && !autoFetchedRef.current) {
			autoFetchedRef.current = true;
			void sync();
		}
	}, [opencode.cachedModels, cacheStale, isSyncing, sync]);

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

	function clearAll() {
		void persist({ enabledModelIds: [] });
	}

	const runningCount = runningOpencode.length;

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
						aria-label="Sync models"
						disabled={isSyncing}
						onClick={onSyncClick}
					>
						<RefreshCcw
							className={cn("size-3.5", isSyncing && "animate-spin")}
						/>
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					Sync models — re-reads ~/.config/opencode
				</TooltipContent>
			</Tooltip>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={(open) => {
					if (!isSyncing) setConfirmOpen(open);
				}}
				title="Sync OpenCode models?"
				description={`Re-reading your config restarts OpenCode and will stop ${runningCount} running ${runningCount === 1 ? "chat" : "chats"}.`}
				confirmLabel="Sync anyway"
				onConfirm={() => {
					void reloadSync().finally(() => setConfirmOpen(false));
				}}
				loading={isSyncing}
			/>
		</div>
	);
}
