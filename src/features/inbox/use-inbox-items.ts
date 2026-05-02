import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type InboxItem,
	type InboxItemDetailRef,
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
	items: InboxItemWithDetailRef[];
	hasNextPage: boolean;
	isLoading: boolean;
	isFetching: boolean;
	isFetchingNextPage: boolean;
	error: unknown;
	fetchNextPage: () => void;
	refetch: () => void;
};

export type InboxItemWithDetailRef = InboxItem & {
	detailRef: InboxItemDetailRef;
};

/** Which sub-tab the inbox sidebar is showing. The Rust backend supports
 * multi-source merging, but in practice an active developer's recent
 * activity is dominated by PRs — merging into a single page-20 window
 * crowds out issues and discussions to "page 2+" they'd never reach
 * through the UI. So each tab gets its own dedicated infinite query
 * with `toggles` set so the backend only fetches the requested kind. */
export type InboxKind = "issues" | "prs" | "discussions";

const KIND_TO_TOGGLES: Record<InboxKind, InboxToggles> = {
	issues: { issues: true, prs: false, discussions: false },
	prs: { issues: false, prs: true, discussions: false },
	discussions: { issues: false, prs: false, discussions: true },
};

/** Drives the kanban-inbox list for ONE sub-tab at a time. The caller
 * passes the current GitHub sub-type tab; switching tabs swaps to a
 * different cached query (TanStack reuses prior pages on switch-back).
 *
 * Single-account today — picks the first GitHub login. The hook is
 * shaped for future multi-account fan-out (run one infinite query per
 * account-kind pair, merge in the consumer). */
export function useInboxItems(kind: InboxKind): UseInboxItemsResult {
	const accounts = useEnabledGithubAccounts();
	const primary = accounts[0] ?? null;
	// Honor the per-account settings toggle for THIS kind — flipping
	// `Issues` off in Settings → Inbox disables this tab's fetch.
	const settingsAllowsKind = primary
		? kind === "issues"
			? primary.toggles.issues
			: kind === "prs"
				? primary.toggles.prs
				: primary.toggles.discussions
		: false;
	const enabled = primary !== null && settingsAllowsKind;

	const query = useInfiniteQuery<InboxPage, Error>({
		queryKey: ["inbox-items", "github", primary?.login ?? "", kind],
		enabled,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam }) => {
			if (!primary) {
				return { items: [], nextCursor: null };
			}
			return listInboxItems({
				provider: "github",
				login: primary.login,
				toggles: KIND_TO_TOGGLES[kind],
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit: PAGE_SIZE,
			});
		},
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		staleTime: STALE_MS,
	});

	const items = useMemo<InboxItemWithDetailRef[]>(
		() =>
			(query.data?.pages ?? []).flatMap((p) =>
				p.items.map((item) => ({
					...item,
					detailRef: {
						provider: "github",
						login: primary?.login ?? "",
						source: item.source,
						externalId: item.externalId,
					},
				})),
			),
		[primary?.login, query.data],
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
