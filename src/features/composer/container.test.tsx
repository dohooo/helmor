import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";

const composerMockState = vi.hoisted(() => ({
	renders: [] as string[],
	mounts: 0,
	unmounts: 0,
}));

vi.mock("./index", async () => {
	const React = await import("react");

	return {
		WorkspaceComposer: (props: {
			contextKey: string;
			selectedModelId: string | null;
		}) => {
			composerMockState.renders.push(props.contextKey);
			React.useEffect(() => {
				composerMockState.mounts += 1;
				return () => {
					composerMockState.unmounts += 1;
				};
			}, []);

			return (
				<div data-testid="workspace-composer-mock">
					{props.contextKey}:{props.selectedModelId ?? "none"}
				</div>
			);
		},
	};
});

import { WorkspaceComposerContainer } from "./container";

const MODEL_SECTIONS = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "opus-1m",
				provider: "claude",
				label: "Opus 4.6 1M",
				cliModel: "opus-1m",
				effortLevels: ["low", "medium", "high"],
			},
		],
	},
	{
		id: "codex",
		label: "Codex",
		options: [
			{
				id: "gpt-5.4",
				provider: "codex",
				label: "GPT-5.4",
				cliModel: "gpt-5.4",
				effortLevels: ["low", "medium", "high"],
			},
		],
	},
] as const;

const WORKSPACE_DETAIL = {
	id: "workspace-1",
	title: "Workspace 1",
	repoId: "repo-1",
	repoName: "helmor",
	directoryName: "helmor",
	state: "ready",
	hasUnread: false,
	workspaceUnread: 0,
	sessionUnreadTotal: 0,
	unreadSessionCount: 0,
	derivedStatus: "in-progress",
	manualStatus: null,
	activeSessionId: "session-1",
	activeSessionTitle: "Session 1",
	activeSessionAgentType: "claude",
	activeSessionStatus: "idle",
	branch: "main",
	initializationParentBranch: "main",
	intendedTargetBranch: "main",
	notes: null,
	pinnedAt: null,
	prTitle: null,
	prDescription: null,
	archiveCommit: null,
	sessionCount: 2,
	messageCount: 2,
	attachmentCount: 0,
	rootPath: "/tmp/helmor",
};

const WORKSPACE_SESSIONS = [
	{
		id: "session-1",
		workspaceId: "workspace-1",
		title: "Session 1",
		agentType: "claude",
		status: "idle",
		model: "opus-1m",
		permissionMode: "default",
		providerSessionId: null,
		unreadCount: 0,
		contextTokenCount: 0,
		contextUsedPercent: null,
		thinkingEnabled: true,
		codexThinkingLevel: null,
		fastMode: false,
		agentPersonality: null,
		createdAt: "2026-04-05T00:00:00Z",
		updatedAt: "2026-04-05T00:00:00Z",
		lastUserMessageAt: null,
		resumeSessionAt: null,
		isHidden: false,
		isCompacting: false,
		active: true,
	},
	{
		id: "session-2",
		workspaceId: "workspace-1",
		title: "Session 2",
		agentType: "codex",
		status: "idle",
		model: "gpt-5.4",
		permissionMode: "default",
		providerSessionId: null,
		unreadCount: 0,
		contextTokenCount: 0,
		contextUsedPercent: null,
		thinkingEnabled: true,
		codexThinkingLevel: "high",
		fastMode: false,
		agentPersonality: null,
		createdAt: "2026-04-05T00:00:00Z",
		updatedAt: "2026-04-05T00:00:00Z",
		lastUserMessageAt: null,
		resumeSessionAt: null,
		isHidden: false,
		isCompacting: false,
		active: false,
	},
];

describe("WorkspaceComposerContainer", () => {
	beforeEach(() => {
		composerMockState.renders = [];
		composerMockState.mounts = 0;
		composerMockState.unmounts = 0;
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("does not remount the composer when switching displayed sessions", () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.agentModelSections,
			MODEL_SECTIONS,
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			WORKSPACE_DETAIL,
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			WORKSPACE_SESSIONS,
		);

		const renderComposer = (displayedSessionId: string) => (
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposerContainer
					displayedWorkspaceId="workspace-1"
					displayedSessionId={displayedSessionId}
					disabled={false}
					sending={false}
					sendError={null}
					restoreDraft={null}
					restoreImages={[]}
					restoreFiles={[]}
					restoreNonce={0}
					modelSelections={{}}
					effortLevels={{}}
					permissionModes={{}}
					onSelectModel={vi.fn()}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>
		);
		const { rerender } = render(renderComposer("session-1"));

		expect(screen.getByTestId("workspace-composer-mock")).toHaveTextContent(
			"session:session-1:opus-1m",
		);
		expect(composerMockState.mounts).toBe(1);
		expect(composerMockState.unmounts).toBe(0);

		rerender(renderComposer("session-2"));

		expect(screen.getByTestId("workspace-composer-mock")).toHaveTextContent(
			"session:session-2:gpt-5.4",
		);
		expect(composerMockState.mounts).toBe(1);
		expect(composerMockState.unmounts).toBe(0);
		expect(composerMockState.renders).toEqual([
			"session:session-1",
			"session:session-2",
		]);
	});

	it("auto-submits queued CLI prompts with queued model and permission mode", async () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.agentModelSections,
			MODEL_SECTIONS,
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			WORKSPACE_DETAIL,
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			WORKSPACE_SESSIONS,
		);

		const onSubmit = vi.fn();
		const onPendingPromptConsumed = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposerContainer
					displayedWorkspaceId="workspace-1"
					displayedSessionId="session-1"
					disabled={false}
					sending={false}
					sendError={null}
					restoreDraft={null}
					restoreImages={[]}
					restoreFiles={[]}
					restoreNonce={0}
					modelSelections={{}}
					effortLevels={{}}
					permissionModes={{}}
					onSelectModel={vi.fn()}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onSubmit={onSubmit}
					pendingPromptForSession={{
						sessionId: "session-1",
						prompt: "Plan the fix",
						modelId: "gpt-5.4",
						permissionMode: "plan",
					}}
					onPendingPromptConsumed={onPendingPromptConsumed}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "Plan the fix",
				model: expect.objectContaining({
					id: "gpt-5.4",
					provider: "codex",
				}),
				permissionMode: "plan",
			}),
		);
		expect(onPendingPromptConsumed).toHaveBeenCalledTimes(1);
	});
});
