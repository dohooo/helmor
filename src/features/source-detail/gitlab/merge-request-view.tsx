import { useQuery } from "@tanstack/react-query";
import { getInboxItemDetail } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { GitHubDetailPage, type SourceDetailProps } from "../common";

export function GitLabMergeRequestView({
	card,
	appendContextTarget,
}: SourceDetailProps) {
	const detailRef =
		card.detailRef?.source === "gitlab_mr" ? card.detailRef : null;
	const detailQuery = useQuery({
		queryKey: detailRef
			? helmorQueryKeys.inboxItemDetail(
					detailRef.provider,
					detailRef.login,
					detailRef.source,
					detailRef.externalId,
				)
			: ["inboxItemDetail", "missing", card.id],
		queryFn: () => getInboxItemDetail(detailRef!),
		enabled: detailRef !== null,
		staleTime: 60_000,
	});
	const detail =
		detailQuery.data?.type === "gitlab_mr" ? detailQuery.data.data : null;

	return (
		<GitHubDetailPage
			card={card}
			appendContextTarget={appendContextTarget}
			description={detail?.body ?? undefined}
			error={detailQuery.error}
			isLoading={detailQuery.isLoading}
			kindLabel="merge request"
		/>
	);
}
