import { memo } from "react";
import type { ContextCard } from "@/lib/sources/types";
import { GitHubDiscussionView } from "./github/discussion-view";
import { GitHubIssueView } from "./github/issue-view";
import { GitHubPullRequestView } from "./github/pull-request-view";
import { UnsupportedSourceView } from "./unsupported-view";

// `memo` keeps the markdown render in `GitHubDetailPage` from re-running
// when the surrounding start page changes state. Once a card is open and the
// detail data has been fetched, the only reason to re-render is when the
// `card` reference itself changes.
export const SourceDetailView = memo(function SourceDetailView({
	card,
}: {
	card: ContextCard;
}) {
	switch (card.source) {
		case "github_issue":
			return <GitHubIssueView card={card} />;
		case "github_pr":
			return <GitHubPullRequestView card={card} />;
		case "github_discussion":
			return <GitHubDiscussionView card={card} />;
		case "linear":
		case "slack_thread":
			return <UnsupportedSourceView card={card} />;
	}
});
