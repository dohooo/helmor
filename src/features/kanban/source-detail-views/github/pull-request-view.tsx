import { GitHubDetailPage, type SourceDetailProps } from "../common";

const PULL_REQUEST_DESCRIPTION = `## Summary

This refines the GitHub inbox detail surface so opened pull requests read like a lightweight GitHub conversation view instead of an internal debug panel.

The main change is replacing the table-based layout with a focused markdown description area. The header keeps the important scan targets: title, number, repository, state, and update time.

## Test plan

- [x] Open a GitHub pull request card from the inbox
- [x] Confirm the header stays compact and readable
- [x] Confirm markdown headings, lists, and checkboxes render correctly`;

export function GitHubPullRequestView({ card }: SourceDetailProps) {
	return (
		<GitHubDetailPage
			card={card}
			description={PULL_REQUEST_DESCRIPTION}
			kindLabel="pull request"
		/>
	);
}
