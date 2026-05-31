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
		card.detailRef?.source === "gitlab_mr" ||
		card.detailRef?.source === "gitea_pr"
			? card.detailRef
			: null;
	const detailQuery = useInboxItemDetailQuery(detailRef, card.id);
	const detail =
		detailQuery.data?.type === "gitlab_mr" ||
		detailQuery.data?.type === "gitea_pr"
			? detailQuery.data.data
			: null;
	const kindLabel =
		card.source === "gitea_pr" ? "pull request" : "merge request";

	return (
		<GitHubDetailPage
			card={card}
			appendContextTarget={appendContextTarget}
			description={detail?.body ?? undefined}
			error={detailQuery.error}
			isLoading={detailQuery.isLoading}
			kindLabel={kindLabel}
			refresh={detailRef ? toRefreshControl(detailQuery) : undefined}
		/>
	);
}
