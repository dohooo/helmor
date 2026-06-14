// Custom-provider CRUD for file-backed families (OpenCode / MiMo). After a write,
// debounce a server sync to refresh models — skipped while a turn is running.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	type CustomProvider,
	listCustomProviders,
	removeCustomProvider,
	upsertCustomProvider,
} from "@/lib/api";
import { activeStreamsQueryOptions, helmorQueryKeys } from "@/lib/query-client";
import type { CustomProvidersController } from "../provider-config";
import { MIMO_ADAPTER, OPENCODE_ADAPTER } from "../slug-provider-adapter";
import { useSlugProviderModelSync } from "../use-opencode-model-sync";

export function useSlugBackedProviders(
	family: "opencode" | "mimo",
): CustomProvidersController {
	const queryClient = useQueryClient();
	const slugAdapter = family === "mimo" ? MIMO_ADAPTER : OPENCODE_ADAPTER;
	const { sync } = useSlugProviderModelSync(slugAdapter);
	const activeStreamsQuery = useQuery(activeStreamsQueryOptions());
	const query = useQuery({
		queryKey: helmorQueryKeys.customProviders(family),
		queryFn: () => listCustomProviders(family),
	});
	const providers = useMemo(() => query.data ?? [], [query.data]);

	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	// Latest running-stream count, read inside the debounce without stale closure.
	const runningRef = useRef(0);
	runningRef.current = (activeStreamsQuery.data ?? []).filter(
		(s) => s.provider === family,
	).length;

	const afterWrite = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.customProviders(family),
		});
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			if (runningRef.current === 0) void sync({ forceReload: true });
		}, 1500);
	}, [family, queryClient, sync]);

	const upsert = useCallback(
		async (provider: CustomProvider) => {
			await upsertCustomProvider(family, provider);
			afterWrite();
		},
		[family, afterWrite],
	);

	const remove = useCallback(
		async (id: string) => {
			await removeCustomProvider(family, id);
			afterWrite();
		},
		[family, afterWrite],
	);

	return { providers, loading: query.isLoading, upsert, remove };
}
