// Custom-provider CRUD for Kimi — file-backed (`~/.kimi-code/config.toml`),
// like OpenCode. After a write, re-sync Kimi's model cache so the composer
// picker + Settings "Models" row refresh.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	type CustomProvider,
	listCustomProviders,
	removeCustomProvider,
	upsertCustomProvider,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import type { CustomProvidersController } from "../provider-config";
import { useKimiModelSync } from "../use-kimi-model-sync";

export function useKimiBackedProviders(): CustomProvidersController {
	const queryClient = useQueryClient();
	const { sync } = useKimiModelSync();
	const query = useQuery({
		queryKey: helmorQueryKeys.customProviders("kimi"),
		queryFn: () => listCustomProviders("kimi"),
	});
	const providers = useMemo(() => query.data ?? [], [query.data]);

	const afterWrite = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.customProviders("kimi"),
		});
		// Refresh the composer model picker + Settings "Models" row.
		void sync().catch(() => {});
	}, [queryClient, sync]);

	const upsert = useCallback(
		async (provider: CustomProvider) => {
			await upsertCustomProvider("kimi", provider);
			afterWrite();
		},
		[afterWrite],
	);
	const remove = useCallback(
		async (id: string) => {
			await removeCustomProvider("kimi", id);
			afterWrite();
		},
		[afterWrite],
	);

	return { providers, loading: query.isLoading, upsert, remove };
}
