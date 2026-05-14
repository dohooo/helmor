export type ContextCardSource =
	| "linear"
	| "github_issue"
	| "github_pr"
	| "github_discussion"
	| "gitlab_issue"
	| "gitlab_mr"
	| "slack_thread";

export type ContextCardForgeSource = Extract<
	ContextCardSource,
	| "github_issue"
	| "github_pr"
	| "github_discussion"
	| "gitlab_issue"
	| "gitlab_mr"
>;

export type ContextCardStateTone =
	| "open"
	| "closed"
	| "merged"
	| "draft"
	| "answered"
	| "unanswered"
	| "urgent"
	| "neutral";

export type ContextCardForgeDetailRef = {
	provider: "github" | "gitlab";
	login: string;
	source: ContextCardForgeSource;
	externalId: string;
};

export type ContextCard = {
	id: string;
	source: ContextCardSource;
	externalId: string;
	externalUrl: string;
	title: string;
	subtitle?: string;
	state?: { label: string; tone: ContextCardStateTone };
	lastActivityAt: number;
	detailRef?: ContextCardForgeDetailRef;
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

export type GitLabIssueMeta = {
	type: "gitlab_issue";
	/** GitLab project full path (`group/sub/project`). */
	repo: string;
	number: number;
	labels: { name: string; color: string }[];
};

export type GitLabMRMeta = {
	type: "gitlab_mr";
	repo: string;
	number: number;
	draft: boolean;
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
	| GitLabIssueMeta
	| GitLabMRMeta
	| SlackThreadMeta;
