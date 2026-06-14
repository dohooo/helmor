// Shared hooks for settings-backed provider families (Claude / Codex).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	listCustomProviders,
	removeCustomProvider,
	upsertCustomProvider,
} from "@/lib/api";
import {
	type CustomProvider,
	type ProviderFamily,
	resolveEnabled,
	toggleEnabled,
} from "@/lib/provider-config";
import {
	allAgentModelSectionsQueryOptions,
	helmorQueryKeys,
} from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import type {
	CustomProvidersController,
	SectionModelsController,
} from "../provider-config";

export function useSettingsBackedProviders(
	family: ProviderFamily,
): CustomProvidersController {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: helmorQueryKeys.customProviders(family),
		queryFn: () => listCustomProviders(family),
	});
	const providers = useMemo(() => query.data ?? [], [query.data]);

	const invalidate = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.customProviders(family),
		});
		// Custom models feed the catalog → refresh both picker views.
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.agentModelSections,
		});
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.allAgentModelSections,
		});
	}, [family, queryClient]);

	const upsert = useCallback(
		async (provider: CustomProvider) => {
			await upsertCustomProvider(family, provider);
			invalidate();
		},
		[family, invalidate],
	);

	const remove = useCallback(
		async (id: string) => {
			await removeCustomProvider(family, id);
			invalidate();
		},
		[family, invalidate],
	);

	return { providers, loading: query.isLoading, upsert, remove };
}

// Section-level Models list for a merged official family (Claude/Codex).
export function useOfficialSectionModels(
	family: "claude" | "codex",
): SectionModelsController {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const sectionsQuery = useQuery(allAgentModelSectionsQueryOptions());

	const available = useMemo(() => {
		const section = sectionsQuery.data?.find((s) => s.id === family);
		return (section?.options ?? []).map((o) => ({
			slug: o.id,
			label: o.label,
		}));
	}, [sectionsQuery.data, family]);

	const stored =
		family === "claude"
			? settings.claudeEnabledModelIds
			: settings.codexEnabledModelIds;
	const enabledIds = resolveEnabled(stored, available);
	const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);

	const persist = useCallback(
		(next: string[]) => {
			const patch =
				family === "claude"
					? { claudeEnabledModelIds: next }
					: { codexEnabledModelIds: next };
			void Promise.resolve(updateSettings(patch)).then(() =>
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.agentModelSections,
				}),
			);
		},
		[family, updateSettings, queryClient],
	);

	const refresh = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.allAgentModelSections,
		});
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.agentModelSections,
		});
	}, [queryClient]);

	return {
		available,
		enabledIds,
		enabledSet,
		toggle: (id: string) => persist(toggleEnabled(stored, available, id)),
		clear: () => persist([]),
		loading: sectionsQuery.isLoading,
		refresh,
		grouped: false,
	};
}
