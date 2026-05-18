import type {
	ActionStatusKind,
	GroupTone,
	InspectorFileStatus,
	WorkspaceBranchTone,
} from "./ui/shared";

/**
 * Mock data fed into the mockup-private `.ui.tsx` primitives. Types come
 * from `./ui/shared` (mockup-private string literals), NOT from
 * `@/lib/api` — that's how we keep the onboarding preview from breaking
 * when production types evolve.
 */

export type MockWorkspaceRow = {
	id: string;
	title: string;
	branch: string;
	repoInitials: string;
	branchTone: WorkspaceBranchTone;
	hasUnread?: boolean;
	isSending?: boolean;
	isSelected?: boolean;
	state?: "active" | "archived";
	status?: "backlog" | "in-progress" | "review" | "done" | "canceled";
	/**
	 * When true, this row is a spotlight target during the `cliSplitSpotlight`
	 * onboarding pass — used to highlight the three workspaces the assistant
	 * just spun up via `helmor workspace new` so the punch-through effect
	 * draws the eye to them.
	 */
	cliSplitTarget?: boolean;
};

export type MockWorkspaceGroup = {
	id: string;
	label: string;
	tone: GroupTone;
	rows: MockWorkspaceRow[];
};

export type MockSession = {
	id: string;
	title: string;
	provider: "claude" | "codex";
	active?: boolean;
	unread?: boolean;
	streaming?: boolean;
};

export type MockMessagePart =
	| { type: "reasoning"; label: string }
	| { type: "todo"; items: Array<{ label: string; done?: boolean }> }
	| {
			type: "tool";
			name: string;
			detail: string;
			/**
			 * When true, this tool call is a spotlight target during the
			 * `cliSplitSpotlight` onboarding pass — paired with the matching
			 * sidebar row so both render as the same bright island under the
			 * mask.
			 */
			cliSplitTarget?: boolean;
	  }
	| { type: "text"; text: string };

export type MockMessage =
	| { id: string; role: "user"; text: string }
	| { id: string; role: "assistant"; parts: MockMessagePart[] };

export type MockChangeItem = {
	name: string;
	path: string;
	status: InspectorFileStatus;
	insertions?: number;
	deletions?: number;
};

export type MockActionStatus = {
	label: string;
	status: ActionStatusKind;
	action?: string;
};

export const mockSidebar: {
	selectedWorkspaceId: string;
	groups: MockWorkspaceGroup[];
} = {
	selectedWorkspaceId: "workspace-auth-main",
	groups: [
		{
			id: "done",
			label: "Done",
			tone: "done",
			rows: [
				{
					id: "workspace-release",
					title: "Release v1.2",
					branch: "release/v1.2",
					repoInitials: "HE",
					branchTone: "merged",
				},
			],
		},
		{
			id: "review",
			label: "In review",
			tone: "review",
			rows: [
				{
					id: "workspace-settings",
					title: "Settings refresh",
					branch: "review/settings",
					repoInitials: "ST",
					branchTone: "open",
					hasUnread: true,
				},
			],
		},
		{
			id: "progress",
			label: "In progress",
			tone: "progress",
			rows: [
				{
					id: "workspace-auth-main",
					title: "Auth feature plan",
					branch: "feature/user-auth",
					repoInitials: "UA",
					branchTone: "working",
					isSending: true,
					isSelected: true,
				},
				{
					id: "workspace-auth-db",
					title: "User Auth - Database",
					branch: "feature/user-auth-db",
					repoInitials: "DB",
					branchTone: "working",
					cliSplitTarget: true,
				},
				{
					id: "workspace-auth-be",
					title: "User Auth - Backend",
					branch: "feature/user-auth-be",
					repoInitials: "BE",
					branchTone: "working",
					cliSplitTarget: true,
				},
				{
					id: "workspace-auth-fe",
					title: "User Auth - Frontend",
					branch: "feature/user-auth-fe",
					repoInitials: "FE",
					branchTone: "working",
					cliSplitTarget: true,
				},
			],
		},
		{
			id: "backlog",
			label: "Backlog",
			tone: "backlog",
			rows: [
				{
					id: "workspace-cleanup",
					title: "API cleanup",
					branch: "task/api-cleanup",
					repoInitials: "AC",
					branchTone: "inactive",
				},
			],
		},
	],
};

export const mockConversation: {
	branch: string;
	branchTone: WorkspaceBranchTone;
	targetBranch: { remote: string; branch: string };
	sessions: MockSession[];
	messages: MockMessage[];
} = {
	branch: "feature/user-auth",
	branchTone: "working" as WorkspaceBranchTone,
	targetBranch: { remote: "origin", branch: "main" },
	sessions: [
		{
			id: "session-plan",
			title: "Plan workspace split",
			provider: "claude",
			active: true,
		},
		{
			id: "session-contracts",
			title: "Refine API contracts",
			provider: "codex",
			unread: true,
			streaming: true,
		},
	],
	messages: [
		{
			id: "user-1",
			role: "user",
			text: "Split this feature into three workspaces — DB migration, backend handlers, and frontend wiring — so I can pair on each in parallel.",
		},
		{
			id: "assistant-1",
			role: "assistant",
			parts: [
				{ type: "reasoning", label: "Planning the workspace split" },
				{
					type: "tool",
					name: "Bash",
					detail: "helmor workspace new --repo helmor  # DB",
					cliSplitTarget: true,
				},
				{
					type: "tool",
					name: "Bash",
					detail: "helmor workspace new --repo helmor  # backend",
					cliSplitTarget: true,
				},
				{
					type: "tool",
					name: "Bash",
					detail: "helmor workspace new --repo helmor  # frontend",
					cliSplitTarget: true,
				},
				{
					type: "text",
					text: "Spun up three workspaces — switch between them in the sidebar to keep each lane moving.",
				},
			],
		},
	],
};

export const mockInspector: {
	changes: MockChangeItem[];
	gitActions: MockActionStatus[];
	reviewActions: MockActionStatus[];
} = {
	changes: [
		{
			name: "0042_user_auth.sql",
			path: "migrations/0042_user_auth.sql",
			status: "A",
			insertions: 86,
		},
		{
			name: "users_seed.sql",
			path: "seed/users_seed.sql",
			status: "A",
			insertions: 24,
		},
		{
			name: "schema.ts",
			path: "src/db/schema.ts",
			status: "M",
			insertions: 12,
			deletions: 4,
		},
	],
	gitActions: [
		{ label: "3 changes", status: "pending", action: "Commit" },
		{ label: "Branch unpublished", status: "pending", action: "Push" },
		{ label: "Up to date", status: "success" },
	],
	reviewActions: [{ label: "Waiting for review", status: "pending" }],
};
