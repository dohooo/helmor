import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
	type SlackInboxItem,
	type SlackInboxPage,
	slackListInboxItems,
} from "@/lib/api";
import { helmorQueryKeys, PERSIST_META } from "@/lib/query-client";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";

const PAGE_SIZE = 30;
/** Slack feed isn't realtime-pushed to us, so we re-validate every minute
 *  on focus rather than every render. Manual refresh is still available
 *  via `refetch()`. */
const STALE_MS = 60_000;

export type UseSlackInboxItemsResult = {
	items: SlackInboxItem[];
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	error: unknown;
	hasResolved: boolean;
	fetchNextPage: () => void;
	refetch: () => void;
};

/** Drives the Slack Activity feed for a single workspace. Disabled when
 *  `teamId` is null (e.g. user hasn't connected any workspaces yet).
 *  Errors fan out to a workspace toast in addition to the inline error
 *  state the consumer renders — same pattern as `useInboxItems` for
 *  GitHub/GitLab so the two feel symmetric. */
export function useSlackInboxItems(
	teamId: string | null,
): UseSlackInboxItemsResult {
	const enabled = teamId !== null;
	const query = useInfiniteQuery<SlackInboxPage, Error>({
		queryKey: teamId
			? helmorQueryKeys.slackInbox(teamId)
			: ["slackInbox", "__none__"],
		enabled,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam }) => {
			if (!teamId) {
				return { items: [], nextCursor: null };
			}
			return slackListInboxItems({
				teamId,
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit: PAGE_SIZE,
			});
		},
		getNextPageParam: (lastPage) =>
			lastPage.items.length > 0
				? (lastPage.nextCursor ?? undefined)
				: undefined,
		staleTime: STALE_MS,
		// Persist across cold start so switching to the Slack tab after
		// app launch shows the last-seen feed instantly (stale-while-
		// revalidate). The persisted blob covers every page the user
		// fetched in the previous session — typically just page 1 at
		// 30 items × ~1 KB. Background refetch on focus (per the
		// global `refetchOnWindowFocus: true` default) replaces the
		// hydrated snapshot once Slack responds.
		meta: PERSIST_META,
	});

	const pushToast = useWorkspaceToast();
	const lastErrorRef = useRef<unknown>(null);
	useEffect(() => {
		if (!query.error) {
			lastErrorRef.current = null;
			return;
		}
		if (lastErrorRef.current === query.error) return;
		lastErrorRef.current = query.error;
		const message =
			query.error instanceof Error
				? query.error.message
				: "Couldn't load Slack inbox items.";
		pushToast(message, "Slack fetch failed", "destructive");
	}, [query.error, pushToast]);

	const items = useMemo<SlackInboxItem[]>(
		() => (query.data?.pages ?? []).flatMap((p) => p.items),
		[query.data],
	);

	return {
		items,
		hasNextPage: Boolean(query.hasNextPage),
		isFetchingNextPage: query.isFetchingNextPage,
		error: query.error,
		hasResolved: query.data !== undefined,
		fetchNextPage: () => {
			void query.fetchNextPage();
		},
		refetch: () => {
			void query.refetch();
		},
	};
}
