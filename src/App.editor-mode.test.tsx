import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	loadWorkspaceGroups: vi.fn(),
	loadArchivedWorkspaces: vi.fn(),
	loadWorkspaceDetail: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
	loadSessionMessages: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
	listWorkspaceChangesWithContent: vi.fn(),
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

vi.mock("./lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/api")>();

	return {
		...actual,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		loadSessionMessages: apiMocks.loadSessionThreadMessages,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		listWorkspaceChangesWithContent: apiMocks.listWorkspaceChangesWithContent,
	};
});

vi.mock("./components/workspace-editor-surface", () => ({
	WorkspaceEditorSurface: (props: {
		editorSession: {
			path: string;
			dirty?: boolean;
			kind: "file" | "diff";
			inline?: boolean;
			originalText?: string;
			modifiedText?: string;
		};
		onChangeSession: (session: Record<string, unknown>) => void;
		onExit: () => void;
	}) => (
		<div aria-label="Mock editor surface">
			<div>{props.editorSession.path}</div>
			<div>{props.editorSession.kind}</div>
			<button type="button" onClick={props.onExit}>
				Back to chat
			</button>
			<button
				type="button"
				onClick={() =>
					props.onChangeSession({
						...props.editorSession,
						dirty: true,
						modifiedText: "updated",
					})
				}
			>
				Mark dirty
			</button>
		</div>
	),
}));

import App from "./App";

function createWorkspaceDetail() {
	return {
		id: "workspace-1",
		title: "Workspace One",
		repoId: "repo-1",
		repoName: "helmor",
		directoryName: "editor-mode",
		state: "ready",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "in-progress",
		manualStatus: null,
		activeSessionId: "session-1",
		activeSessionTitle: "Session One",
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
		sessionCount: 1,
		messageCount: 1,
		attachmentCount: 0,
		rootPath: "/tmp/helmor-workspace",
	};
}

function createWorkspaceSessions() {
	return [
		{
			id: "session-1",
			workspaceId: "workspace-1",
			title: "Session One",
			agentType: "claude",
			status: "idle",
			model: "opus-1m",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 0,
			contextUsedPercent: null,
			thinkingEnabled: true,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-06T00:00:00Z",
			updatedAt: "2026-04-06T00:00:00Z",
			lastUserMessageAt: null,
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: true,
		},
	];
}

function createMessages() {
	return [
		{
			id: "message-1",
			sessionId: "session-1",
			role: "assistant",
			content: "hello",
			contentIsJson: false,
			createdAt: "2026-04-06T00:00:00Z",
			sentAt: "2026-04-06T00:00:00Z",
			cancelledAt: null,
			model: "opus-1m",
			sdkMessageId: null,
			lastAssistantMessageId: null,
			turnId: null,
			isResumableMessage: null,
			attachmentCount: 0,
		},
	];
}

async function renderReadyApp() {
	render(<App />);

	await waitFor(() => {
		expect(screen.getByRole("button", { name: "Workspace One" })).toBeVisible();
	});
	screen.getByRole("button", { name: "Workspace One" }).click();

	await waitFor(() => {
		expect(
			within(screen.getByLabelText("Inspector sidebar")).getByText("App.tsx"),
		).toBeVisible();
	});
}

describe("App editor mode", () => {
	beforeEach(() => {
		window.localStorage.clear();
		apiMocks.loadWorkspaceGroups.mockReset();
		apiMocks.loadArchivedWorkspaces.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionMessages.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();
		apiMocks.listWorkspaceChangesWithContent.mockReset();

		apiMocks.loadWorkspaceGroups.mockResolvedValue([
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						id: "workspace-1",
						title: "Workspace One",
						repoName: "helmor",
						state: "ready",
					},
				],
			},
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [],
			},
			{
				id: "review",
				label: "In review",
				tone: "review",
				rows: [],
			},
			{
				id: "backlog",
				label: "Backlog",
				tone: "backlog",
				rows: [],
			},
			{
				id: "canceled",
				label: "Canceled",
				tone: "canceled",
				rows: [],
			},
		]);
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
		apiMocks.loadWorkspaceDetail.mockResolvedValue(createWorkspaceDetail());
		apiMocks.loadWorkspaceSessions.mockResolvedValue(createWorkspaceSessions());
		apiMocks.loadSessionMessages.mockResolvedValue(createMessages());
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		apiMocks.listWorkspaceChangesWithContent.mockResolvedValue({
			items: [
				{
					path: "src/App.tsx",
					absolutePath: "/tmp/helmor-workspace/src/App.tsx",
					name: "App.tsx",
					status: "M",
					insertions: 3,
					deletions: 1,
				},
				{
					path: "src/lib/api.ts",
					absolutePath: "/tmp/helmor-workspace/src/lib/api.ts",
					name: "api.ts",
					status: "M",
					insertions: 2,
					deletions: 0,
				},
			],
			prefetched: [],
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("enters editor mode from inspector and returns to chat", async () => {
		const user = userEvent.setup();
		await renderReadyApp();
		const inspector = screen.getByLabelText("Inspector sidebar");

		await user.click(within(inspector).getByText("App.tsx"));

		expect(
			screen.queryByLabelText("Workspace sidebar"),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("Inspector sidebar")).toBeInTheDocument();
		expect(screen.getByLabelText("Mock editor surface")).toBeInTheDocument();
		expect(
			screen.getByText("/tmp/helmor-workspace/src/App.tsx"),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Back to chat" }));

		expect(screen.getByLabelText("Workspace sidebar")).toBeInTheDocument();
		expect(
			screen.queryByLabelText("Mock editor surface"),
		).not.toBeInTheDocument();
	});

	it("prompts before leaving editor mode with dirty changes", async () => {
		const user = userEvent.setup();
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		await renderReadyApp();
		const inspector = screen.getByLabelText("Inspector sidebar");

		await user.click(within(inspector).getByText("App.tsx"));
		await user.click(screen.getByRole("button", { name: "Mark dirty" }));
		await user.click(screen.getByRole("button", { name: "Back to chat" }));

		expect(confirmSpy).toHaveBeenCalled();
		expect(screen.getByLabelText("Mock editor surface")).toBeInTheDocument();
		expect(
			screen.queryByLabelText("Workspace sidebar"),
		).not.toBeInTheDocument();
	});

	it("prompts before switching files when the editor is dirty", async () => {
		const user = userEvent.setup();
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		await renderReadyApp();
		const inspector = screen.getByLabelText("Inspector sidebar");

		await user.click(within(inspector).getByText("App.tsx"));
		await user.click(screen.getByRole("button", { name: "Mark dirty" }));
		await user.click(within(inspector).getByText("api.ts"));

		expect(confirmSpy).toHaveBeenCalled();
		expect(
			screen.getByText("/tmp/helmor-workspace/src/App.tsx"),
		).toBeInTheDocument();
	});
});
