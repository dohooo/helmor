import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type InboxItem,
	type InboxPage,
	type InboxToggles,
	listInboxItems,
} from "@/lib/api";
import {
	DEFAULT_INBOX_ACCOUNT_TOGGLES,
	type InboxAccountSourceToggles,
	useSettings,
} from "@/lib/settings";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";

const PAGE_SIZE = 20;
/** Stale window — keep cached pages fresh enough to feel live without
 * re-fetching on every kanban switch. Manual refetch path lives on the
 * caller (e.g. a refresh button). */
const STALE_MS = 60_000;

type GithubAccountInboxArgs = {
	login: string;
	toggles: InboxAccountSourceToggles;
};

/** Resolves the GitHub accounts the inbox should fan out across, with
 * their per-account toggles merged from settings. Single-account today
 * (we only support one GH login at a time in the picker), but the hook
 * is shaped for future fan-out. */
function useEnabledGithubAccounts(): GithubAccountInboxArgs[] {
	const accountsQuery = useForgeAccountsAll();
	const { settings } = useSettings();
	return useMemo(() => {
		const githubAccounts = (accountsQuery.data ?? []).filter(
			(a) => a.provider === "github",
		);
		const accountsConfig = settings.inboxSourceConfig?.accounts ?? {};
		return githubAccounts.map((account) => {
			const key = `github:${account.login}`;
			const toggles = accountsConfig[key] ?? DEFAULT_INBOX_ACCOUNT_TOGGLES;
			return { login: account.login, toggles };
		});
	}, [accountsQuery.data, settings.inboxSourceConfig]);
}

export type UseInboxItemsResult = {
	items: InboxItem[];
	hasNextPage: boolean;
	isLoading: boolean;
	isFetching: boolean;
	isFetchingNextPage: boolean;
	error: unknown;
	fetchNextPage: () => void;
	refetch: () => void;
};

/** Drives the kanban-inbox list. Currently single-account (the picker
 * exposes one login at a time); the hook is kept account-aware so we
 * can fan out cleanly when multi-account inbox lands. */
export function useInboxItems(): UseInboxItemsResult {
	const accounts = useEnabledGithubAccounts();
	// V1: single account. Pick the first one and run a per-account
	// infinite query against it.
	const primary = accounts[0] ?? null;
	const enabled =
		primary !== null &&
		(primary.toggles.issues ||
			primary.toggles.prs ||
			primary.toggles.discussions);

	const query = useInfiniteQuery<InboxPage, Error>({
		// Re-key on toggle changes so flipping a switch in Settings
		// triggers a fresh first-page fetch.
		queryKey: [
			"inbox-items",
			"github",
			primary?.login ?? "",
			primary?.toggles.issues ?? false,
			primary?.toggles.prs ?? false,
			primary?.toggles.discussions ?? false,
		],
		enabled,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam }) => {
			if (!primary) {
				return { items: [], nextCursor: null };
			}
			const toggles: InboxToggles = {
				issues: primary.toggles.issues,
				prs: primary.toggles.prs,
				discussions: primary.toggles.discussions,
			};
			return listInboxItems({
				provider: "github",
				login: primary.login,
				toggles,
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit: PAGE_SIZE,
			});
		},
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		staleTime: STALE_MS,
	});

	const items = useMemo(
		() => (query.data?.pages ?? []).flatMap((p) => p.items),
		[query.data],
	);

	return {
		items,
		hasNextPage: Boolean(query.hasNextPage),
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		isFetchingNextPage: query.isFetchingNextPage,
		error: query.error,
		fetchNextPage: () => {
			void query.fetchNextPage();
		},
		refetch: () => {
			void query.refetch();
		},
	};
}
