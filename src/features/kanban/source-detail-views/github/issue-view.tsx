import { GitHubDetailPage, type SourceDetailProps } from "../common";

const ISSUE_DESCRIPTION = `## Summary

Track the broken inbox interaction where selecting a GitHub item opens the right card but the detail pane still feels unfinished.

### Expected behavior

- The title, repository, number, and state are visible at the top.
- The description area renders markdown cleanly.
- Empty sections are not shown as placeholder tables.

### Notes

This is a focused UI pass. Data shape changes should be handled separately.`;

export function GitHubIssueView({ card }: SourceDetailProps) {
	return (
		<GitHubDetailPage
			card={card}
			description={ISSUE_DESCRIPTION}
			kindLabel="issue"
		/>
	);
}
