import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { getOpencodeCustomProviders, listOpencodeModels } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	OPENCODE_CACHE_VERSION,
	type OpencodeCachedModel,
	type OpencodeProviderSettings,
	useSettings,
} from "@/lib/settings";
import { reconcileEnabledModelIds } from "./opencode-model-defaults";

export type OpencodeModelSync = {
	/** `forceReload` restarts `opencode serve` so it re-reads ~/.config/opencode
	 *  (its global config cache never expires). */
	sync: (opts?: { forceReload?: boolean }) => Promise<void>;
	isSyncing: boolean;
};

/** Fetch the opencode model list, reconcile the enabled set, and persist it —
 *  shared by the Settings sync button and the app-start sync so the composer's
 *  picker and the Settings list always stay in lockstep. */
export function useOpencodeModelSync(): OpencodeModelSync {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const opencode = settings.opencodeProvider;

	const { mutateAsync, isPending } = useMutation({
		mutationFn: async (forceReload: boolean) => {
			const models = await listOpencodeModels(forceReload);
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
			const patch: Partial<OpencodeProviderSettings> = {
				status: cached.length > 0 ? "ready" : "unavailable",
				connected,
				cachedModels: cached,
				enabledModelIds: reconcileEnabledModelIds(
					opencode.enabledModelIds,
					cached,
					opencode.cachedModels,
					configuredIds,
				),
				cacheVersion: OPENCODE_CACHE_VERSION,
			};
			await Promise.resolve(
				updateSettings({ opencodeProvider: { ...opencode, ...patch } }),
			);
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			});
		},
	});

	const sync = useCallback(
		async (opts?: { forceReload?: boolean }) => {
			await mutateAsync(opts?.forceReload ?? false);
		},
		[mutateAsync],
	);

	return { sync, isSyncing: isPending };
}
