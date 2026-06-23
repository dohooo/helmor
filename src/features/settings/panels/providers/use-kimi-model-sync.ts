import {
	useIsMutating,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { getKimiProviderConfig } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	type KimiCachedModel,
	type KimiProviderSettings,
	useSettings,
} from "@/lib/settings";

export type KimiModelSync = {
	sync: () => Promise<void>;
	isSyncing: boolean;
};

/** Reconcile the enabled set against a fresh model list: first sync enables all
 *  discovered models; later syncs keep the user's picks, drop removed models,
 *  and auto-enable any newly-discovered ones (so adding a provider surfaces its
 *  models). */
export function reconcileKimiEnabledModelIds(
	prevEnabled: string[] | null,
	cached: KimiCachedModel[],
	prevCached: KimiCachedModel[] | null,
): string[] {
	if (prevEnabled === null) return cached.map((m) => m.id);
	const availableIds = new Set(cached.map((m) => m.id));
	const previouslyKnown = new Set((prevCached ?? []).map((m) => m.id));
	const kept = prevEnabled.filter((id) => availableIds.has(id));
	const newlyDiscovered = cached
		.map((m) => m.id)
		.filter((id) => !previouslyKnown.has(id));
	return [...kept, ...newlyDiscovered];
}

/** Re-read the models Kimi has configured (`kimi provider list`) and cache them
 *  into `app.kimi_provider` so the composer picker and the Settings list stay in
 *  lockstep. Read-only — never restarts anything or interrupts a running turn. */
export function useKimiModelSync(): KimiModelSync {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const kimi = settings.kimiProvider;

	const { mutateAsync } = useMutation({
		mutationKey: ["kimiModelSync"],
		mutationFn: async () => {
			const config = await getKimiProviderConfig();
			const cached: KimiCachedModel[] = config.models.map((m) => ({
				id: m.id,
				label: m.label,
			}));
			const patch: Partial<KimiProviderSettings> = {
				cachedModels: cached,
				enabledModelIds: reconcileKimiEnabledModelIds(
					kimi.enabledModelIds,
					cached,
					kimi.cachedModels,
				),
			};
			await Promise.resolve(
				updateSettings({ kimiProvider: { ...kimi, ...patch } }),
			);
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			});
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.kimiProviderConfig,
			});
		},
	});
	// Global, not per-instance — a sync kicked off from any panel (Models row,
	// Custom Providers, login exit) should spin/disable every other one.
	const isSyncing = useIsMutating({ mutationKey: ["kimiModelSync"] }) > 0;

	const sync = useCallback(async () => {
		await mutateAsync();
	}, [mutateAsync]);

	return { sync, isSyncing };
}
