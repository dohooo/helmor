import {
	GitHubDetailPage,
	type SourceDetailProps,
	toRefreshControl,
	useInboxItemDetailQuery,
} from "../common";

export function GitLabMergeRequestView({
	card,
	appendContextTarget,
}: SourceDetailProps) {
	const detailRef =
		card.detailRef?.source === "gitlab_mr" ? card.detailRef : null;
	const detailQuery = useInboxItemDetailQuery(detailRef, card.id);
	const detail =
		detailQuery.data?.type === "gitlab_mr" ? detailQuery.data.data : null;

	return (
		<GitHubDetailPage
			card={card}
			appendContextTarget={appendContextTarget}
			description={detail?.body ?? undefined}
			error={detailQuery.error}
			isLoading={detailQuery.isLoading}
			kindLabel="miscMergeRequest"
			refresh={detailRef ? toRefreshControl(detailQuery) : undefined}
		/>
	);
}
