import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";
import { DEFAULT_SETTINGS, SettingsContext } from "@/lib/settings";

const apiMockState = vi.hoisted(() => ({
	listSlashCommands: vi.fn(),
	listWorkspaceLinkedDirectories: vi.fn(),
	setWorkspaceLinkedDirectories: vi.fn(),
	mutateCodexGoal: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		listSlashCommands: apiMockState.listSlashCommands,
		listWorkspaceLinkedDirectories: apiMockState.listWorkspaceLinkedDirectories,
		setWorkspaceLinkedDirectories: apiMockState.setWorkspaceLinkedDirectories,
		mutateCodexGoal: apiMockState.mutateCodexGoal,
	};
});

type PickHandler = (entry: unknown) => void;
type RemoveHandler = (path: string) => void;

type ComposerSubmitHandler = (
	prompt: string,
	imagePaths: string[],
	filePaths: string[],
	customTags: unknown[],
	options?: {
		permissionModeOverride?: string;
		oppositeFollowUp?: boolean;
		startSubmitMode?: StartSubmitMode;
	},
) => void;

const composerMockState = vi.hoisted(() => ({
	renders: [] as string[],
	mounts: 0,
	unmounts: 0,
	lastSlashCommands: [] as Array<{
		name: string;
		description: string;
		source: string;
		providers?: readonly string[] | null;
	}>,
	lastLinkedDirectories: [] as readonly string[],
	lastOnRemoveLinkedDirectory: null as RemoveHandler | null,
	lastAddDirCandidates: [] as readonly unknown[],
	lastOnPickAddDir: null as PickHandler | null,
	lastOnSubmit: null as ComposerSubmitHandler | null,
	lastStartSubmitMode: null as StartSubmitMode | null,
	lastOnStartSubmitModeChange: null as ((mode: StartSubmitMode) => void) | null,
	lastOnSelectModel: null as ((modelId: string) => void) | null,
	lastOnSelectEffort: null as ((level: string) => void) | null,
	lastOnChangePermissionMode: null as ((mode: string) => void) | null,
	lastOnChangeFastMode: null as ((enabled: boolean) => void) | null,
}));

vi.mock("./index", async () => {
	const React = await import("react");

	return {
		WorkspaceComposer: (props: {
			contextKey: string;
			selectedModelId: string | null;
			fastMode?: boolean;
			disabled?: boolean;
			submitDisabled?: boolean;
			slashCommands?: readonly {
				name: string;
				description: string;
				source: string;
				providers?: readonly string[] | null;
			}[];
			linkedDirectories?: readonly string[];
			onRemoveLinkedDirectory?: RemoveHandler;
			addDirCandidates?: readonly unknown[];
			onPickAddDir?: PickHandler;
			onSubmit?: ComposerSubmitHandler;
			startSubmitMode?: StartSubmitMode;
			onStartSubmitModeChange?: (mode: StartSubmitMode) => void;
			onSelectModel?: (modelId: string) => void;
			effortLevel?: string;
			onSelectEffort?: (level: string) => void;
			permissionMode?: string;
			onChangePermissionMode?: (mode: string) => void;
			onChangeFastMode?: (enabled: boolean) => void;
		}) => {
			composerMockState.renders.push(props.contextKey);
			composerMockState.lastSlashCommands = [...(props.slashCommands ?? [])];
			composerMockState.lastLinkedDirectories = props.linkedDirectories ?? [];
			composerMockState.lastOnRemoveLinkedDirectory =
				props.onRemoveLinkedDirectory ?? null;
			composerMockState.lastAddDirCandidates = [
				...(props.addDirCandidates ?? []),
			];
			composerMockState.lastOnPickAddDir = props.onPickAddDir ?? null;
			composerMockState.lastOnSubmit = props.onSubmit ?? null;
			composerMockState.lastStartSubmitMode = props.startSubmitMode ?? null;
			composerMockState.lastOnStartSubmitModeChange =
				props.onStartSubmitModeChange ?? null;
			composerMockState.lastOnSelectModel = props.onSelectModel ?? null;
			composerMockState.lastOnSelectEffort = props.onSelectEffort ?? null;
			composerMockState.lastOnChangePermissionMode =
				props.onChangePermissionMode ?? null;
			composerMockState.lastOnChangeFastMode = props.onChangeFastMode ?? null;
			React.useEffect(() => {
				composerMockState.mounts += 1;
				return () => {
					composerMockState.unmounts += 1;
				};
			}, []);

			return (
				<div
					data-testid="workspace-composer-mock"
					data-fast-mode={props.fastMode ? "on" : "off"}
					data-effort-level={props.effortLevel ?? ""}
					data-permission-mode={props.permissionMode ?? ""}
					data-disabled={props.disabled ? "true" : "false"}
					data-submit-disabled={props.submitDisabled ? "true" : "false"}
				>
					{props.contextKey}:{props.selectedModelId ?? "none"}
				</div>
			);
		},
	};
});

import { WorkspaceComposerContainer } from "./container";
import type { StartSubmitMode } from "./start-submit-mode";

const MODEL_SECTIONS = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "opus-1m",
				provider: "claude",
				label: "Opus 4.7 1M",
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
				supportsFastMode: true,
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
	unreadSessionCount: 0,
	status: "in-progress",
	activeSessionId: "session-1",
	activeSessionTitle: "Session 1",
	activeSessionAgentType: "claude",
	activeSessionStatus: "idle",
	branch: "main",
	initializationParentBranch: "main",
	intendedTargetBranch: "main",
	pinnedAt: null,
	prTitle: null,
	archiveCommit: null,
	sessionCount: 2,
	messageCount: 2,
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
		codexThinkingLevel: null,
		fastMode: false,
		createdAt: "2026-04-05T00:00:00Z",
		updatedAt: "2026-04-05T00:00:00Z",
		lastUserMessageAt: null,
		isHidden: false,
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
		codexThinkingLevel: "high",
		fastMode: false,
		createdAt: "2026-04-05T00:00:00Z",
		updatedAt: "2026-04-05T00:00:00Z",
		lastUserMessageAt: null,
		isHidden: false,
		active: false,
	},
];

describe("WorkspaceComposerContainer", () => {
	beforeEach(() => {
		composerMockState.renders = [];
		composerMockState.mounts = 0;
		composerMockState.unmounts = 0;
		composerMockState.lastOnSubmit = null;
		composerMockState.lastOnSelectModel = null;
		composerMockState.lastOnSelectEffort = null;
		composerMockState.lastOnChangePermissionMode = null;
		composerMockState.lastOnChangeFastMode = null;
		apiMockState.listSlashCommands.mockReset();
		apiMockState.listWorkspaceLinkedDirectories.mockReset();
		apiMockState.listWorkspaceLinkedDirectories.mockResolvedValue([]);
		apiMockState.setWorkspaceLinkedDirectories.mockReset();
		apiMockState.mutateCodexGoal.mockReset();
		apiMockState.mutateCodexGoal.mockResolvedValue(undefined);
		apiMockState.listSlashCommands.mockResolvedValue({
			commands: [],
		});
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
					fastModes={{}}
					onSelectModel={vi.fn()}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onChangeFastMode={vi.fn()}
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
		// Allow extra synchronous renders from react-query observers
		// (CodexGoal banner subscribes to a per-session query). The
		// invariant we care about: no remount, and the session id seen
		// in the rendered child stream eventually flips to session-2.
		expect(composerMockState.renders[0]).toBe("session:session-1");
		expect(
			composerMockState.renders[composerMockState.renders.length - 1],
		).toBe("session:session-2");
	});

	it("uses the context-key model selection before a workspace exists", () => {
		const queryClient = createHelmorQueryClient();
		const handleSelectModel = vi.fn();
		queryClient.setQueryData(
			helmorQueryKeys.agentModelSections,
			MODEL_SECTIONS,
		);

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposerContainer
					displayedWorkspaceId={null}
					displayedSessionId={null}
					disabled={false}
					forceAvailable
					contextKeyOverride="start:repo:repo-1"
					sending={false}
					sendError={null}
					restoreDraft={null}
					restoreImages={[]}
					restoreFiles={[]}
					restoreNonce={0}
					modelSelections={{ "start:repo:repo-1": "gpt-5.4" }}
					effortLevels={{}}
					permissionModes={{}}
					fastModes={{}}
					onSelectModel={handleSelectModel}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onChangeFastMode={vi.fn()}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByTestId("workspace-composer-mock")).toHaveTextContent(
			"start:repo:repo-1:gpt-5.4",
		);

		composerMockState.lastOnSelectModel?.("opus-1m");

		expect(handleSelectModel).toHaveBeenCalledWith(
			"start:repo:repo-1",
			"opus-1m",
		);
	});

	it("uses context-key effort/plan/fast selections before a workspace exists", () => {
		const queryClient = createHelmorQueryClient();
		const handleSelectEffort = vi.fn();
		const handleChangePermissionMode = vi.fn();
		const handleChangeFastMode = vi.fn();
		queryClient.setQueryData(
			helmorQueryKeys.agentModelSections,
			MODEL_SECTIONS,
		);

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposerContainer
					displayedWorkspaceId={null}
					displayedSessionId={null}
					disabled={false}
					forceAvailable
					contextKeyOverride="start:repo:repo-1"
					sending={false}
					sendError={null}
					restoreDraft={null}
					restoreImages={[]}
					restoreFiles={[]}
					restoreNonce={0}
					modelSelections={{ "start:repo:repo-1": "gpt-5.4" }}
					effortLevels={{ "start:repo:repo-1": "low" }}
					permissionModes={{ "start:repo:repo-1": "plan" }}
					fastModes={{ "start:repo:repo-1": true }}
					onSelectModel={vi.fn()}
					onSelectEffort={handleSelectEffort}
					onChangePermissionMode={handleChangePermissionMode}
					onChangeFastMode={handleChangeFastMode}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		const mock = screen.getByTestId("workspace-composer-mock");
		expect(mock).toHaveAttribute("data-effort-level", "low");
		expect(mock).toHaveAttribute("data-permission-mode", "plan");
		expect(mock).toHaveAttribute("data-fast-mode", "on");

		composerMockState.lastOnSelectEffort?.("medium");
		composerMockState.lastOnChangePermissionMode?.("bypassPermissions");
		composerMockState.lastOnChangeFastMode?.(false);

		expect(handleSelectEffort).toHaveBeenCalledWith(
			"start:repo:repo-1",
			"medium",
		);
		expect(handleChangePermissionMode).toHaveBeenCalledWith(
			"start:repo:repo-1",
			"bypassPermissions",
		);
		expect(handleChangeFastMode).toHaveBeenCalledWith(
			"start:repo:repo-1",
			false,
		);
	});

	it("forwards the start submit mode into the composer payload", () => {
		const queryClient = createHelmorQueryClient();
		const handleSubmit = vi.fn();
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
					fastModes={{}}
					onSelectModel={vi.fn()}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onChangeFastMode={vi.fn()}
					onSubmit={handleSubmit}
					startSubmitMenu
				/>
			</QueryClientProvider>,
		);

		composerMockState.lastOnSubmit?.("Save this for later.", [], [], [], {
			startSubmitMode: "saveForLater",
		});

		expect(handleSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "Save this for later.",
				startSubmitMode: "saveForLater",
			}),
		);
	});

	it("persists the selected start submit mode in settings", () => {
		const queryClient = createHelmorQueryClient();
		const updateSettings = vi.fn();
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

		render(
			<SettingsContext.Provider
				value={{
					settings: {
						...DEFAULT_SETTINGS,
						kanbanViewState: {
							...DEFAULT_SETTINGS.kanbanViewState,
							createState: "backlog",
						},
					},
					isLoaded: true,
					updateSettings,
				}}
			>
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
						fastModes={{}}
						onSelectModel={vi.fn()}
						onSelectEffort={vi.fn()}
						onChangePermissionMode={vi.fn()}
						onChangeFastMode={vi.fn()}
						onSubmit={vi.fn()}
						startSubmitMenu
					/>
				</QueryClientProvider>
			</SettingsContext.Provider>,
		);

		expect(composerMockState.lastStartSubmitMode).toBe("saveForLater");

		composerMockState.lastOnStartSubmitModeChange?.("startNow");

		expect(updateSettings).toHaveBeenCalledWith({
			kanbanViewState: {
				...DEFAULT_SETTINGS.kanbanViewState,
				createState: "in-progress",
			},
		});
	});

	it("auto-submits queued CLI prompts using the model + permission_mode pinned on the session row", async () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.agentModelSections,
			MODEL_SECTIONS,
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			WORKSPACE_DETAIL,
		);
		// CLI-send path pins the resolved model + permissionMode onto the
		// session row before queuing the prompt; the composer reads them off
		// `currentSession` rather than off the (now prompt-only) handoff.
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			WORKSPACE_SESSIONS.map((session) =>
				session.id === "session-1"
					? { ...session, model: "gpt-5.4", permissionMode: "plan" }
					: session,
			),
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
					fastModes={{}}
					onSelectModel={vi.fn()}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onChangeFastMode={vi.fn()}
					onSubmit={onSubmit}
					pendingPromptForSession={{
						sessionId: "session-1",
						prompt: "Plan the fix",
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

	it("loads slash commands when the composer mounts", async () => {
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
					fastModes={{}}
					onSelectModel={vi.fn()}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onChangeFastMode={vi.fn()}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() =>
			expect(apiMockState.listSlashCommands).toHaveBeenCalledWith({
				provider: "claude",
				workingDirectory: "/tmp/helmor",
				repoId: "repo-1",
				workspaceId: "workspace-1",
			}),
		);
	});

	it("uses the default fast mode setting for new sessions", () => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.agentModelSections,
			MODEL_SECTIONS,
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail("workspace-1"),
			WORKSPACE_DETAIL,
		);
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions("workspace-1"), [
			...WORKSPACE_SESSIONS,
			{
				id: "session-new",
				workspaceId: "workspace-1",
				title: "Untitled",
				agentType: null,
				status: "idle",
				model: null,
				permissionMode: "default",
				providerSessionId: null,
				unreadCount: 0,
				codexThinkingLevel: null,
				fastMode: false,
				createdAt: "2026-04-05T00:00:00Z",
				updatedAt: "2026-04-05T00:00:00Z",
				lastUserMessageAt: null,
				isHidden: false,
				active: false,
			},
		]);

		render(
			<SettingsContext.Provider
				value={{
					settings: {
						...DEFAULT_SETTINGS,
						defaultModelId: "gpt-5.4",
						defaultFastMode: true,
					},
					isLoaded: true,
					updateSettings: vi.fn(),
				}}
			>
				<QueryClientProvider client={queryClient}>
					<WorkspaceComposerContainer
						displayedWorkspaceId="workspace-1"
						displayedSessionId="session-new"
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
						fastModes={{}}
						onSelectModel={vi.fn()}
						onSelectEffort={vi.fn()}
						onChangePermissionMode={vi.fn()}
						onChangeFastMode={vi.fn()}
						onSubmit={vi.fn()}
					/>
				</QueryClientProvider>
			</SettingsContext.Provider>,
		);

		expect(screen.getByTestId("workspace-composer-mock")).toHaveAttribute(
			"data-fast-mode",
			"on",
		);
	});

	// `composerUnavailable` vs `composerAwaitingFinalize`: the composer
	// container must ONLY dim the whole UI when the workspace is genuinely
	// unusable (archived / no selection). During the Phase 2 initializing
	// window the editor + toolbar stay fully live and only the send action
	// is blocked, so users can type-ahead without a visible 60% dim.
	const renderContainerForState = (workspaceState: string) => {
		const queryClient = createHelmorQueryClient();
		queryClient.setQueryData(
			helmorQueryKeys.agentModelSections,
			MODEL_SECTIONS,
		);
		queryClient.setQueryData(helmorQueryKeys.workspaceDetail("workspace-1"), {
			...WORKSPACE_DETAIL,
			state: workspaceState,
		});
		queryClient.setQueryData(
			helmorQueryKeys.workspaceSessions("workspace-1"),
			WORKSPACE_SESSIONS,
		);

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
					fastModes={{}}
					onSelectModel={vi.fn()}
					onSelectEffort={vi.fn()}
					onChangePermissionMode={vi.fn()}
					onChangeFastMode={vi.fn()}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>,
		);
	};

	it("stays fully enabled while the workspace is initializing, blocking only the send action", () => {
		renderContainerForState("initializing");

		const composer = screen.getByTestId("workspace-composer-mock");
		// Editor + toolbar must NOT be dimmed — the user can type and pick
		// model/effort while Phase 2 finishes.
		expect(composer).toHaveAttribute("data-disabled", "false");
		// Send is gated so messages can't race with finalize.
		expect(composer).toHaveAttribute("data-submit-disabled", "true");
	});

	it("fully disables the composer for archived workspaces", () => {
		renderContainerForState("archived");

		const composer = screen.getByTestId("workspace-composer-mock");
		expect(composer).toHaveAttribute("data-disabled", "true");
	});

	it("is fully interactive for ready workspaces", () => {
		renderContainerForState("ready");

		const composer = screen.getByTestId("workspace-composer-mock");
		expect(composer).toHaveAttribute("data-disabled", "false");
		expect(composer).toHaveAttribute("data-submit-disabled", "false");
	});

	it("renders queued follow-ups as an overlay above the composer", () => {
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

		render(
			<TooltipProvider>
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
						fastModes={{}}
						onSelectModel={vi.fn()}
						onSelectEffort={vi.fn()}
						onChangePermissionMode={vi.fn()}
						onChangeFastMode={vi.fn()}
						onSubmit={vi.fn()}
						queueItems={[
							{
								id: "queued-1",
								context: {
									sessionId: "session-1",
									workspaceId: "workspace-1",
									contextKey: "session:session-1",
								},
								payload: {
									prompt: "Continue",
									imagePaths: [],
									filePaths: [],
									customTags: [],
									model: {
										...MODEL_SECTIONS[0].options[0],
										effortLevels: [
											...MODEL_SECTIONS[0].options[0].effortLevels,
										],
									},
									workingDirectory: "/tmp/helmor",
									effortLevel: "medium",
									permissionMode: "default",
									fastMode: false,
								},
								enqueuedAt: Date.now(),
							},
						]}
						onSteerQueued={vi.fn()}
						onRemoveQueued={vi.fn()}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const queueList = screen.getByTestId("submit-queue-list");
		expect(queueList).toHaveClass("pointer-events-auto");
		expect(queueList.parentElement).toHaveClass("absolute");
		expect(queueList.parentElement).toHaveClass("bottom-[calc(100%-1px)]");
	});

	describe("/add-dir integration", () => {
		function renderWithLinkedDirs(
			linked: string[],
			displayedSessionId = "session-1",
		) {
			// Returning the list from the API mock — not setQueryData —
			// so the background refetch (`staleTime: 0`) doesn't overwrite
			// the seeded value with the default setup.ts mock.
			apiMockState.listWorkspaceLinkedDirectories.mockResolvedValue(linked);
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
			return render(
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
						fastModes={{}}
						onSelectModel={vi.fn()}
						onSelectEffort={vi.fn()}
						onChangePermissionMode={vi.fn()}
						onChangeFastMode={vi.fn()}
						onSubmit={vi.fn()}
					/>
				</QueryClientProvider>,
			);
		}

		it("always prepends /add-dir as the first slash command with client-action source", async () => {
			// Have the agent return some regular commands — /add-dir must land
			// ahead of them.
			apiMockState.listSlashCommands.mockResolvedValue({
				commands: [
					{
						name: "compact",
						description: "Compact the context",
						source: "builtin",
					},
					{
						name: "clear",
						description: "Clear history",
						source: "builtin",
					},
				],
				isComplete: true,
			});

			renderWithLinkedDirs([]);

			// Wait until the agent commands merge in behind /add-dir.
			await waitFor(() => {
				expect(composerMockState.lastSlashCommands.map((c) => c.name)).toEqual([
					"add-dir",
					"goal",
					"compact",
					"clear",
				]);
			});
			expect(composerMockState.lastSlashCommands[0]).toEqual({
				name: "add-dir",
				description: "Link extra directories to this workspace",
				source: "client-action",
			});
		});

		it("adds built-in /compact and /goal commands for Codex sessions", async () => {
			apiMockState.listSlashCommands.mockResolvedValue({
				commands: [],
				isComplete: true,
			});

			renderWithLinkedDirs([], "session-2");

			await waitFor(() => {
				expect(composerMockState.lastSlashCommands.map((c) => c.name)).toEqual([
					"add-dir",
					"compact",
					"goal",
				]);
			});
			expect(composerMockState.lastSlashCommands[1]).toEqual({
				name: "compact",
				description: "Compact this Codex thread's context",
				source: "builtin",
				providers: ["codex"],
			});
			expect(composerMockState.lastSlashCommands[2]).toEqual({
				name: "goal",
				description:
					"Set a persistent goal Codex pursues turn-after-turn until done or paused",
				argumentHint: "<objective>",
				source: "builtin",
				providers: ["codex"],
			});
		});

		it("adds a built-in /goal command for Claude sessions without duplicating an agent-provided goal", async () => {
			apiMockState.listSlashCommands.mockResolvedValue({
				commands: [
					{
						name: "goal",
						description: "Agent supplied goal command",
						source: "builtin",
					},
					{
						name: "clear",
						description: "Clear history",
						source: "builtin",
					},
				],
				isComplete: true,
			});

			renderWithLinkedDirs([]);

			await waitFor(() => {
				expect(composerMockState.lastSlashCommands.map((c) => c.name)).toEqual([
					"add-dir",
					"goal",
					"clear",
				]);
			});
			expect(composerMockState.lastSlashCommands[1]).toEqual({
				name: "goal",
				description: "Set a completion condition for Claude to work toward",
				argumentHint: "<condition>",
				source: "builtin",
				providers: ["claude"],
			});
		});

		it("exposes the workspace's linked directories to the composer so the ContextBar + pill-driven popup stay in sync", async () => {
			renderWithLinkedDirs(["/home/me/alpha", "/home/me/beta"]);
			await waitFor(() => {
				expect(composerMockState.lastLinkedDirectories).toEqual([
					"/home/me/alpha",
					"/home/me/beta",
				]);
			});
			// The composer always receives an onPickAddDir callback — the
			// AddDirTypeaheadPlugin dispatches through it when the user
			// picks a candidate from the inline popup.
			expect(composerMockState.lastOnPickAddDir).not.toBeNull();
		});
	});

	// Regression coverage for the review-flagged bug where typing
	// `/goal pause` (or `/goal clear`) was interpreted by the sidecar
	// parser as `{kind: "set", objective: "pause"}` and would silently
	// overwrite the existing goal. The container intercept must short-
	// circuit these out-of-band so they go through `mutateCodexGoal`
	// instead of leaking to the agent stream.
	describe("/goal pause/clear interception", () => {
		const ACTIVE_GOAL = {
			threadId: "t1",
			objective: "improve test coverage",
			status: "active" as const,
			tokenBudget: null,
			tokensUsed: 100,
			timeUsedSeconds: 30,
			createdAt: 0,
			updatedAt: 0,
		};

		function setupCodexSessionWithGoal(): {
			queryClient: ReturnType<typeof createHelmorQueryClient>;
		} {
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
			queryClient.setQueryData(
				helmorQueryKeys.sessionCodexGoal("session-2"),
				ACTIVE_GOAL,
			);
			return { queryClient };
		}

		type ContainerOnSubmit = ComponentProps<
			typeof WorkspaceComposerContainer
		>["onSubmit"];

		function renderCodexComposer(
			queryClient: ReturnType<typeof createHelmorQueryClient>,
			onSubmit: ContainerOnSubmit,
		) {
			render(
				<QueryClientProvider client={queryClient}>
					<TooltipProvider>
						<SettingsContext.Provider
							value={{
								settings: DEFAULT_SETTINGS,
								updateSettings: vi.fn(),
								isLoaded: true,
							}}
						>
							<WorkspaceComposerContainer
								displayedWorkspaceId="workspace-1"
								displayedSessionId="session-2"
								disabled={false}
								sending={false}
								sendError={null}
								restoreDraft={null}
								restoreImages={[]}
								restoreFiles={[]}
								restoreNonce={0}
								modelSelections={{ "session:session-2": "gpt-5.4" }}
								effortLevels={{}}
								permissionModes={{}}
								fastModes={{}}
								onSelectModel={vi.fn()}
								onSelectEffort={vi.fn()}
								onChangePermissionMode={vi.fn()}
								onChangeFastMode={vi.fn()}
								onSubmit={onSubmit}
							/>
						</SettingsContext.Provider>
					</TooltipProvider>
				</QueryClientProvider>,
			);
		}

		it("routes /goal pause to mutateCodexGoal and does NOT call onSubmit", async () => {
			const { queryClient } = setupCodexSessionWithGoal();
			const onSubmit = vi.fn<ContainerOnSubmit>();
			renderCodexComposer(queryClient, onSubmit);

			await waitFor(() =>
				expect(composerMockState.lastOnSubmit).not.toBeNull(),
			);

			composerMockState.lastOnSubmit?.("/goal pause", [], [], []);

			expect(apiMockState.mutateCodexGoal).toHaveBeenCalledTimes(1);
			expect(apiMockState.mutateCodexGoal).toHaveBeenCalledWith(
				"session-2",
				"pause",
			);
			expect(onSubmit).not.toHaveBeenCalled();
		});

		it("routes /goal clear to mutateCodexGoal and does NOT call onSubmit", async () => {
			const { queryClient } = setupCodexSessionWithGoal();
			const onSubmit = vi.fn<ContainerOnSubmit>();
			renderCodexComposer(queryClient, onSubmit);

			await waitFor(() =>
				expect(composerMockState.lastOnSubmit).not.toBeNull(),
			);

			composerMockState.lastOnSubmit?.("/goal clear", [], [], []);

			expect(apiMockState.mutateCodexGoal).toHaveBeenCalledTimes(1);
			expect(apiMockState.mutateCodexGoal).toHaveBeenCalledWith(
				"session-2",
				"clear",
			);
			expect(onSubmit).not.toHaveBeenCalled();
		});

		it("lets /goal resume fall through to onSubmit (sendMessage path)", async () => {
			const { queryClient } = setupCodexSessionWithGoal();
			const onSubmit = vi.fn<ContainerOnSubmit>();
			renderCodexComposer(queryClient, onSubmit);

			await waitFor(() =>
				expect(composerMockState.lastOnSubmit).not.toBeNull(),
			);

			composerMockState.lastOnSubmit?.("/goal resume", [], [], []);

			expect(apiMockState.mutateCodexGoal).not.toHaveBeenCalled();
			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: "/goal resume" }),
			);
		});
	});
});
