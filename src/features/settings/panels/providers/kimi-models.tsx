import { useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { I18nText } from "@/lib/i18n";
import { helmorQueryKeys } from "@/lib/query-client";
import { type KimiProviderSettings, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ModelMultiSelect } from "./model-multi-select";
import { useKimiModelSync } from "./use-kimi-model-sync";

/** Pick which of the user's configured Kimi models appear in the composer
 *  picker. `kimi provider list` is read-only, so syncing never interrupts a
 *  running turn — no confirm dialog (unlike OpenCode's server restart). */
export function KimiModels() {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const kimi = settings.kimiProvider;
	const { sync, isSyncing } = useKimiModelSync();

	const persist = useCallback(
		async (patch: Partial<KimiProviderSettings>) => {
			await Promise.resolve(
				updateSettings({ kimiProvider: { ...kimi, ...patch } }),
			);
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			});
		},
		[kimi, queryClient, updateSettings],
	);

	// First open with no cache → fetch once.
	const autoFetchedRef = useRef(false);
	useEffect(() => {
		if (kimi.cachedModels === null && !isSyncing && !autoFetchedRef.current) {
			autoFetchedRef.current = true;
			// Swallow — kimi may be uninstalled / not logged in; the panel just
			// stays empty rather than surfacing an unhandled rejection.
			void sync().catch(() => {});
		}
	}, [kimi.cachedModels, isSyncing, sync]);

	const cached = kimi.cachedModels ?? [];
	const available = useMemo(
		() => cached.map((m) => ({ id: m.id, label: m.label })),
		[cached],
	);
	const enabledIds = kimi.enabledModelIds ?? [];
	const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);

	// A sync writes the whole enabled set back from a snapshot taken when it
	// started, so a toggle landing mid-sync would be silently rolled back —
	// ignore them while one is in flight (`isSyncing` is global across panels).
	function toggle(id: string) {
		if (isSyncing) return;
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
				onClear={() => {
					if (!isSyncing) void persist({ enabledModelIds: [] });
				}}
				loading={isSyncing}
				grouped={false}
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
						onClick={() => void sync().catch(() => {})}
					>
						<RefreshCcw
							className={cn("size-3.5", isSyncing && "animate-spin")}
						/>
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<I18nText source="syncModelsReReadsKimiCode" />
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
