export type ContextCardSource =
	| "linear"
	| "github_issue"
	| "github_pr"
	| "github_discussion"
	| "slack_thread";

export type ContextCardStateTone =
	| "open"
	| "closed"
	| "merged"
	| "draft"
	| "answered"
	| "unanswered"
	| "urgent"
	| "neutral";

export type ContextCard = {
	id: string;
	source: ContextCardSource;
	externalId: string;
	externalUrl: string;
	title: string;
	subtitle?: string;
	state?: { label: string; tone: ContextCardStateTone };
	lastActivityAt: number;
	detailRef?: {
		provider: "github";
		login: string;
		source: Extract<
			ContextCardSource,
			"github_issue" | "github_pr" | "github_discussion"
		>;
		externalId: string;
	};
	meta: ContextCardMeta;
};

export type LinearIssueMeta = {
	type: "linear";
	identifier: string;
	priorityLabel: string;
	team: { name: string; key: string };
	project?: { name: string; color: string };
	labels: { name: string; color: string }[];
};

export type GitHubIssueMeta = {
	type: "github_issue";
	repo: string;
	number: number;
	labels: { name: string; color: string }[];
};

export type GitHubPRMeta = {
	type: "github_pr";
	repo: string;
	number: number;
	additions: number;
	deletions: number;
	changedFiles: number;
	ciStatus?: "success" | "failure" | "pending" | "neutral";
};

export type GitHubDiscussionMeta = {
	type: "github_discussion";
	repo: string;
	number: number;
	category: { name: string; emoji: string };
};

export type SlackThreadMeta = {
	type: "slack_thread";
	workspaceName: string;
	channelName: string;
	rootAuthor: { name: string };
};

export type ContextCardMeta =
	| LinearIssueMeta
	| GitHubIssueMeta
	| GitHubPRMeta
	| GitHubDiscussionMeta
	| SlackThreadMeta;
