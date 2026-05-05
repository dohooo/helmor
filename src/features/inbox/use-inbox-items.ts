import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
	type InboxFilters,
	type InboxItem,
	type InboxItemDetailRef,
	type InboxPage,
	type InboxToggles,
	listInboxItems,
} from "@/lib/api";
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

type GithubAccountInboxArgs = {
	login: string;
	toggles: InboxAccountSourceToggles;
};

type ActiveInboxToggles = InboxAccountSourceToggles | InboxRepoSourceConfig;

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
 * passes the current GitHub sub-type tab; switching tabs swaps to a
 * different cached query (TanStack reuses prior pages on switch-back).
 *
 * `repoFilter` is the `owner/name` for the kanban's currently-selected
 * repo. When provided, every kind is scoped to that single repo via a
 * `repo:owner/name` GraphQL search qualifier on the backend. Each repo
 * gets its own cache key so switching the repo picker doesn't trash
 * the previous repo's cached pages.
 *
 * Single-account today — picks the first GitHub login. The hook is
 * shaped for future multi-account fan-out (run one infinite query per
 * account-kind pair, merge in the consumer). */
export function useInboxItems(
	kind: InboxKind,
	repoFilter: string | null = null,
	filters: InboxFilters | null = null,
): UseInboxItemsResult {
	const accounts = useEnabledGithubAccounts();
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
	// Honor the per-account settings toggle for THIS kind — flipping
	// `Issues` off in Settings → Context disables this tab's fetch.
	const settingsAllowsKind = activeToggles
		? kind === "issues"
			? activeToggles.issues
			: kind === "prs"
				? activeToggles.prs
				: activeToggles.discussions
		: false;
	const enabled = primary !== null && settingsAllowsKind;
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
			"github",
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
				provider: "github",
				login: primary.login,
				toggles: KIND_TO_TOGGLES[kind],
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
	// fetch silently dies (network, gh auth, GraphQL errors). The
	// inline `<InboxErrorState>` still renders as the primary
	// affordance — toast is an extra nudge in case the user is on a
	// different sub-tab when the failure happens.
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
