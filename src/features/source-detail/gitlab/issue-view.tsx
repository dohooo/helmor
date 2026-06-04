import {
	GitHubDetailPage,
	type SourceDetailProps,
	toRefreshControl,
	useInboxItemDetailQuery,
} from "../common";

export function GitLabIssueView({
	card,
	appendContextTarget,
}: SourceDetailProps) {
	const detailRef =
		card.detailRef?.source === "gitlab_issue" ||
		card.detailRef?.source === "gitea_issue"
			? card.detailRef
			: null;
	const detailQuery = useInboxItemDetailQuery(detailRef, card.id);
	const detail =
		detailQuery.data?.type === "gitlab_issue" ||
		detailQuery.data?.type === "gitea_issue"
			? detailQuery.data.data
			: null;

	return (
		<GitHubDetailPage
			card={card}
			appendContextTarget={appendContextTarget}
			description={detail?.body ?? undefined}
			error={detailQuery.error}
			isLoading={detailQuery.isLoading}
			kindLabel="issue"
			refresh={detailRef ? toRefreshControl(detailQuery) : undefined}
		/>
	);
}
