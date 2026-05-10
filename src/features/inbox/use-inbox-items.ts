import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
	type ForgeProvider,
	type InboxFilters,
	type InboxItem,
	type InboxItemDetailRef,
	type InboxKind,
	type InboxPage,
	listInboxItems,
} from "@/lib/api";

export type { InboxKind };

import {
	DEFAULT_INBOX_ACCOUNT_TOGGLES,
	DEFAULT_INBOX_REPO_CONFIG,
	type InboxAccountSourceToggles,
	type InboxDiscussionState,
	type InboxIssueState,
	type InboxPullRequestState,
	type InboxRepoSourceConfig,
	useSettings,
} from "@/lib/settings";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";

const PAGE_SIZE = 20;
/** Stale window — keep cached pages fresh enough to feel live without
 * re-fetching on every kanban switch. Manual refetch path lives on the
 * caller (e.g. a refresh button). */
const STALE_MS = 60_000;

type ForgeAccountInboxArgs = {
	login: string;
	toggles: InboxAccountSourceToggles;
};

type ActiveInboxToggles = InboxAccountSourceToggles | InboxRepoSourceConfig;

/** Forge providers the inbox can talk to. Excludes "unknown" since it
 *  has no backend implementation. */
type InboxProvider = Extract<ForgeProvider, "github" | "gitlab">;

/** Resolves the accounts the inbox should fan out across for a given
 *  forge, with their per-account toggles merged from settings.
 *  Single-account in practice today (one login per provider), but the
 *  hook is shaped for future fan-out. */
function useEnabledForgeAccounts(
	provider: InboxProvider,
): ForgeAccountInboxArgs[] {
	const accountsQuery = useForgeAccountsAll();
	const { settings } = useSettings();
	return useMemo(() => {
		const matching = (accountsQuery.data ?? []).filter(
			(a) => a.provider === provider,
		);
		const accountsConfig = settings.inboxSourceConfig?.accounts ?? {};
		return matching.map((account) => {
			const key = `${provider}:${account.login}`;
			const toggles = accountsConfig[key] ?? DEFAULT_INBOX_ACCOUNT_TOGGLES;
			return { login: account.login, toggles };
		});
	}, [accountsQuery.data, settings.inboxSourceConfig, provider]);
}

export type UseInboxItemsResult = {
	items: InboxItemWithDetailRef[];
	hasNextPage: boolean;
	isLoading: boolean;
	isFetching: boolean;
	isFetchingNextPage: boolean;
	error: unknown;
	/** True when the user has at least one GitHub account AND the
	 *  Settings → Context toggle for this kind is on. False here is the
	 *  consumer's signal to render the "kind disabled in settings"
	 *  state instead of the empty / loading states. */
	kindEnabled: boolean;
	/** True once the underlying infinite query has produced at least
	 *  one successful response. Use this to gate the "no items" empty
	 *  state — without it, an in-flight first fetch flashes "empty"
	 *  before the data lands. */
	hasResolved: boolean;
	fetchNextPage: () => void;
	refetch: () => void;
};

export type InboxItemWithDetailRef = InboxItem & {
	detailRef: InboxItemDetailRef;
};

function defaultStateForKind(
	kind: InboxKind,
	toggles: ActiveInboxToggles,
): InboxIssueState | InboxPullRequestState | InboxDiscussionState {
	if (kind === "issues") return toggles.issueState;
	if (kind === "prs") return toggles.prState;
	return toggles.discussionState;
}

function scopeForKind(kind: InboxKind, toggles: ActiveInboxToggles) {
	if (kind === "issues") return toggles.issueScopes;
	if (kind === "prs") return toggles.prScopes;
	return null;
}

/** Drives the kanban-inbox list for ONE sub-tab at a time. The caller
 * passes the current forge provider plus sub-type tab; switching tabs
 * swaps to a different cached query (TanStack reuses prior pages on
 * switch-back).
 *
 * `repoFilter` is the `owner/name` (GitHub) or `group/sub/project`
 * (GitLab) for the kanban's currently-selected repo. When provided,
 * every kind is scoped to that single repo on the backend. Each repo
 * gets its own cache key so switching the repo picker doesn't trash
 * the previous repo's cached pages.
 *
 * Single-account today — picks the first matching login. The hook is
 * shaped for future multi-account fan-out (run one infinite query per
 * account-kind pair, merge in the consumer). */
export function useInboxItems(
	kind: InboxKind,
	repoFilter: string | null = null,
	filters: InboxFilters | null = null,
	provider: InboxProvider = "github",
	/** Host the API call should target — `gitlab.example.com` for
	 *  self-hosted GitLab, `github.com` for GitHub. Derived from the
	 *  repo's remote URL, NOT from the bound login. When `null` the
	 *  backend falls back to login-based host derivation (single-host
	 *  case), which is correct for the global "involves @me" feed. */
	host: string | null = null,
): UseInboxItemsResult {
	const accounts = useEnabledForgeAccounts(provider);
	const primary =
		(repoFilter
			? accounts.find((account) => account.toggles.repos?.[repoFilter])
			: undefined) ??
		accounts[0] ??
		null;
	const repoToggles =
		primary && repoFilter
			? (primary.toggles.repos?.[repoFilter] ?? null)
			: null;
	const activeToggles: ActiveInboxToggles | null = repoFilter
		? (repoToggles ?? { ...DEFAULT_INBOX_REPO_CONFIG, enabled: true })
		: (primary?.toggles ?? null);
	// GitLab has no Discussions equivalent; gate the kind out before the
	// settings/account check so disabling it doesn't render a confusing
	// "kind disabled" empty state.
	const providerSupportsKind =
		provider === "gitlab" ? kind !== "discussions" : true;
	// Honor the per-account settings toggle for THIS kind — flipping
	// `Issues` off in Settings → Context disables this tab's fetch.
	const settingsAllowsKind = activeToggles
		? kind === "issues"
			? activeToggles.issues
			: kind === "prs"
				? activeToggles.prs
				: activeToggles.discussions
		: false;
	const enabled =
		primary !== null && providerSupportsKind && settingsAllowsKind;
	const defaultFilters = activeToggles
		? {
				state: defaultStateForKind(kind, activeToggles),
				scope: scopeForKind(kind, activeToggles),
				sort:
					kind === "issues"
						? activeToggles.issueSort
						: kind === "prs"
							? activeToggles.prSort
							: activeToggles.discussionSort,
				draft: kind === "prs" ? activeToggles.draftPrs : null,
				labels:
					kind === "issues"
						? activeToggles.issueLabels.trim() || null
						: kind === "prs"
							? activeToggles.prLabels.trim() || null
							: null,
			}
		: null;
	const resolvedFilters: InboxFilters | null = {
		query: filters?.query ?? null,
		state:
			filters && "state" in filters
				? (filters.state ?? null)
				: (defaultFilters?.state ?? null),
		scope: defaultFilters?.scope ?? null,
		sort: defaultFilters?.sort ?? null,
		draft: defaultFilters?.draft ?? null,
		labels: defaultFilters?.labels ?? null,
	};

	const query = useInfiniteQuery<InboxPage, Error>({
		queryKey: [
			"inbox-items",
			provider,
			host ?? "",
			primary?.login ?? "",
			kind,
			repoFilter ?? "",
			resolvedFilters.query ?? "",
			resolvedFilters.state ?? "",
			(resolvedFilters.scope ?? []).join(","),
			resolvedFilters.sort ?? "",
			resolvedFilters.draft ?? "",
			resolvedFilters.labels ?? "",
		],
		enabled,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam }) => {
			if (!primary) {
				return { items: [], nextCursor: null };
			}
			return listInboxItems({
				provider,
				kind,
				login: primary.login,
				host,
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit: PAGE_SIZE,
				repo: repoFilter,
				filters: resolvedFilters,
			});
		},
		getNextPageParam: (lastPage) =>
			lastPage.items.length > 0
				? (lastPage.nextCursor ?? undefined)
				: undefined,
		staleTime: STALE_MS,
	});

	// Surface query failures as a toast so the user notices when a
	// fetch silently dies (network, auth, API errors). The inline
	// `<InboxErrorState>` still renders as the primary affordance —
	// toast is an extra nudge in case the user is on a different sub-tab
	// when the failure happens.
	const pushToast = useWorkspaceToast();
	const lastSurfacedErrorRef = useRef<unknown>(null);
	useEffect(() => {
		if (!query.error) {
			lastSurfacedErrorRef.current = null;
			return;
		}
		// Same error from a re-render — already toasted.
		if (lastSurfacedErrorRef.current === query.error) return;
		lastSurfacedErrorRef.current = query.error;
		const message =
			query.error instanceof Error
				? query.error.message
				: "Couldn't load context items.";
		pushToast(message, "Context fetch failed", "destructive");
	}, [query.error, pushToast]);

	const items = useMemo<InboxItemWithDetailRef[]>(
		() =>
			(query.data?.pages ?? []).flatMap((p) =>
				p.items.map((item) => ({
					...item,
					detailRef: {
						provider,
						login: primary?.login ?? "",
						host,
						source: item.source,
						externalId: item.externalId,
					},
				})),
			),
		[primary?.login, provider, host, query.data],
	);

	return {
		items,
		hasNextPage: Boolean(query.hasNextPage),
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		isFetchingNextPage: query.isFetchingNextPage,
		error: query.error,
		kindEnabled: enabled,
		hasResolved: query.data !== undefined,
		fetchNextPage: () => {
			void query.fetchNextPage();
		},
		refetch: () => {
			void query.refetch();
		},
	};
}
