import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
	type AgentLoginStatusResult,
	getOpencodeCustomProviders,
	listOpencodeModels,
} from "@/lib/api";
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
		// Keyed so `useIsMutating` can surface a "Connecting…" state in the
		// providers panel while any sync (this one or the app-start one) runs.
		mutationKey: ["opencodeModelSync"],
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
			// Flip opencode's flag in the login-status cache directly so its Ready
			// badge updates the instant the sync lands — invalidating would re-run
			// the slow claude/codex CLI checks bundled in the same command.
			queryClient.setQueryData<AgentLoginStatusResult>(
				helmorQueryKeys.agentLoginStatus,
				(old) => (old ? { ...old, opencode: cached.length > 0 } : old),
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
