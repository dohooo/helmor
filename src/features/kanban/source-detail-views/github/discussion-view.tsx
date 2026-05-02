import { GitHubDetailPage, type SourceDetailProps } from "../common";

const DISCUSSION_DESCRIPTION = `## Question

How should GitHub inbox items be presented when Helmor only needs a fast triage view?

The current direction is to keep the first screen close to GitHub's own conversation page:

1. A direct title and metadata header.
2. A single markdown description block.
3. No sidebar until there is meaningful data to show.

> The detail pane should feel like a readable source preview, not a settings table.`;

export function GitHubDiscussionView({ card }: SourceDetailProps) {
	return (
		<GitHubDetailPage
			card={card}
			description={DISCUSSION_DESCRIPTION}
			kindLabel="discussion"
		/>
	);
}
