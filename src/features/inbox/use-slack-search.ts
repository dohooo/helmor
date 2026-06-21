import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
	type SlackInboxItem,
	type SlackInboxPage,
	type SlackSearchSort,
	slackSearchMessages,
} from "@/lib/api";
import { translateSource } from "@/lib/i18n";
import { helmorQueryKeys } from "@/lib/query-client";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import type { UseSlackInboxItemsResult } from "./use-slack-inbox-items";

const PAGE_SIZE = 30;
/** Search results don't change as fast as the activity feed (the query
 *  the user typed is the cache key, and Slack's search index lag is
 *  fine for an interactive box). Five minutes keeps repeated identical
 *  searches snappy without serving stale-feeling matches. */
const STALE_MS = 5 * 60_000;

/** Drives the search-results list for a single workspace. Disabled
 *  while `teamId` is null OR `query` is blank — empty input collapses
 *  back to the activity feed in the consumer, and disabling here keeps
 *  React Query from caching a useless "empty" placeholder against an
 *  ambiguous key. Shape mirrors {@link UseSlackInboxItemsResult} so
 *  callers can `const inbox = query || activity` and reuse the same
 *  rendering path. */
export function useSlackSearch(
	teamId: string | null,
	query: string,
	sort: SlackSearchSort,
): UseSlackInboxItemsResult {
	const trimmedQuery = query.trim();
	const enabled = teamId !== null && trimmedQuery.length > 0;
	const result = useInfiniteQuery<SlackInboxPage, Error>({
		queryKey: enabled
			? helmorQueryKeys.slackSearch(teamId, trimmedQuery, sort)
			: ["slackSearch", "__disabled__"],
		enabled,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam }) => {
			if (!teamId || trimmedQuery.length === 0) {
				return { items: [], nextCursor: null };
			}
			return slackSearchMessages({
				teamId,
				query: trimmedQuery,
				sort,
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit: PAGE_SIZE,
			});
		},
		getNextPageParam: (lastPage) =>
			lastPage.items.length > 0
				? (lastPage.nextCursor ?? undefined)
				: undefined,
		staleTime: STALE_MS,
	});

	const pushToast = useWorkspaceToast();
	const lastErrorRef = useRef<unknown>(null);
	useEffect(() => {
		if (!result.error) {
			lastErrorRef.current = null;
			return;
		}
		if (lastErrorRef.current === result.error) return;
		lastErrorRef.current = result.error;
		const message =
			result.error instanceof Error
				? result.error.message
				: translateSource("inboxCouldntSearchSlackMessages");
		pushToast(
			message,
			translateSource("inboxSlackSearchFailed"),
			"destructive",
		);
	}, [result.error, pushToast]);

	const items = useMemo<SlackInboxItem[]>(
		() => (result.data?.pages ?? []).flatMap((p) => p.items),
		[result.data],
	);

	return {
		items,
		hasNextPage: Boolean(result.hasNextPage),
		isFetchingNextPage: result.isFetchingNextPage,
		error: result.error,
		hasResolved: result.data !== undefined,
		fetchNextPage: () => {
			void result.fetchNextPage();
		},
		refetch: () => {
			void result.refetch();
		},
	};
}
