import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { AgentLoginStatusResult } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	OPENCODE_CACHE_VERSION,
	type OpencodeCachedModel,
	type OpencodeProviderSettings,
	useSettings,
} from "@/lib/settings";
import { reconcileEnabledModelIds } from "./opencode-model-defaults";
import type { SlugProviderAdapter } from "./slug-provider-adapter";

export type SlugProviderModelSync = {
	/** `forceReload` restarts the provider's server so it re-reads its global
	 *  config (the config cache never expires). */
	sync: (opts?: { forceReload?: boolean }) => Promise<void>;
	isSyncing: boolean;
};

/** Fetch an opencode-protocol provider's model list, reconcile the enabled
 *  set, and persist it — shared by the Settings sync button and the app-start
 *  sync so the composer's picker and the Settings list always stay in
 *  lockstep. */
export function useSlugProviderModelSync(
	adapter: SlugProviderAdapter,
): SlugProviderModelSync {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const current = settings[adapter.settingsKey];

	const { mutateAsync, isPending } = useMutation({
		// Keyed so `useIsMutating` can surface a "Connecting…" state in the
		// providers panel while any sync (this one or the app-start one) runs.
		mutationKey: [...adapter.modelSyncMutationKey],
		mutationFn: async (forceReload: boolean) => {
			const models = await adapter.listModels(forceReload);
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
			// Provider ids the user configured in their config (custom + presets)
			// — their models are intentional and default to enabled.
			const configured = await adapter.getCustomProviders().catch(() => []);
			const configuredIds = new Set(configured.map((p) => p.id));
			const patch: Partial<OpencodeProviderSettings> = {
				status: cached.length > 0 ? "ready" : "unavailable",
				connected,
				cachedModels: cached,
				enabledModelIds: reconcileEnabledModelIds(
					current.enabledModelIds,
					cached,
					current.cachedModels,
					configuredIds,
					adapter.isBuiltinIntentional,
				),
				cacheVersion: OPENCODE_CACHE_VERSION,
			};
			await Promise.resolve(
				updateSettings({ [adapter.settingsKey]: { ...current, ...patch } }),
			);
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			});
			// Flip the provider's flag in the login-status cache directly so its
			// Ready badge updates the instant the sync lands — invalidating would
			// re-run the slow claude/codex CLI checks bundled in the same command.
			queryClient.setQueryData<AgentLoginStatusResult>(
				helmorQueryKeys.agentLoginStatus,
				(old) =>
					old ? { ...old, [adapter.provider]: cached.length > 0 } : old,
			);
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
