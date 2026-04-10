import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	loadGithubIdentitySession: vi.fn(),
	cancelGithubIdentityConnect: vi.fn(),
	listenGithubIdentityChanged: vi.fn(),
	disconnectGithubIdentity: vi.fn(),
	loadWorkspaceGroups: vi.fn(),
	loadArchivedWorkspaces: vi.fn(),
	loadAgentModelSections: vi.fn(),
	listRepositories: vi.fn(),
	loadWorkspaceDetail: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
	loadSessionMessages: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
	loadSessionAttachments: vi.fn(),
}));

const openerMocks = vi.hoisted(() => ({
	openUrl: vi.fn(),
}));

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: openerMocks.openUrl,
}));

vi.mock("./lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./lib/api")>();

	return {
		...actual,
		loadGithubIdentitySession: apiMocks.loadGithubIdentitySession,
		cancelGithubIdentityConnect: apiMocks.cancelGithubIdentityConnect,
		listenGithubIdentityChanged: apiMocks.listenGithubIdentityChanged,
		disconnectGithubIdentity: apiMocks.disconnectGithubIdentity,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
		loadAgentModelSections: apiMocks.loadAgentModelSections,
		listRepositories: apiMocks.listRepositories,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
		loadSessionMessages: apiMocks.loadSessionThreadMessages,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		loadSessionAttachments: apiMocks.loadSessionAttachments,
	};
});

import App from "./App";

const CONNECTED_IDENTITY = {
	provider: "github-app-device-flow",
	githubUserId: 42,
	login: "caspian",
	name: "Caspian",
	avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
	primaryEmail: "caspian@example.com",
	tokenExpiresAt: "2026-04-04T12:00:00Z",
	refreshTokenExpiresAt: "2026-10-04T12:00:00Z",
} as const;

function installTauriRuntime() {
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: {},
		configurable: true,
	});
}

function removeTauriRuntime() {
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

function mockWorkspaceData() {
	apiMocks.loadWorkspaceGroups.mockResolvedValue([
		{
			id: "progress",
			label: "In progress",
			tone: "progress",
			rows: [
				{
					id: "workspace-1",
					title: "Authenticated workspace",
					repoName: "helmor-core",
					state: "ready",
				},
			],
		},
	]);
	apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
	apiMocks.loadAgentModelSections.mockResolvedValue([]);
	apiMocks.listRepositories.mockResolvedValue([]);
	apiMocks.loadWorkspaceDetail.mockResolvedValue({
		id: "workspace-1",
		title: "Authenticated workspace",
		repoId: "repo-1",
		repoName: "helmor-core",
		directoryName: "authenticated-workspace",
		state: "ready",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "in-progress",
		manualStatus: null,
		activeSessionId: "session-1",
		activeSessionTitle: "Untitled",
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
		messageCount: 0,
		attachmentCount: 0,
	});
	apiMocks.loadWorkspaceSessions.mockResolvedValue([
		{
			id: "session-1",
			workspaceId: "workspace-1",
			title: "Untitled",
			agentType: "claude",
			status: "idle",
			model: "opus",
			permissionMode: "default",
			providerSessionId: null,
			unreadCount: 0,
			contextTokenCount: 0,
			contextUsedPercent: null,
			thinkingEnabled: true,
			codexThinkingLevel: null,
			fastMode: false,
			agentPersonality: null,
			createdAt: "2026-04-04T00:00:00Z",
			updatedAt: "2026-04-04T00:00:00Z",
			lastUserMessageAt: null,
			resumeSessionAt: null,
			isHidden: false,
			isCompacting: false,
			active: true,
		},
	]);
	apiMocks.loadSessionMessages.mockResolvedValue([]);
	apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
	apiMocks.loadSessionAttachments.mockResolvedValue([]);
}

async function openGithubMenu() {
	const trigger = await screen.findByRole("button", {
		name: "GitHub account menu",
	});
	fireEvent.pointerDown(trigger);
	fireEvent.click(trigger);
}

describe("App GitHub identity states", () => {
	let _identityListener:
		| ((snapshot: {
				status: string;
				session?: typeof CONNECTED_IDENTITY;
		  }) => void)
		| null;

	beforeEach(() => {
		installTauriRuntime();
		_identityListener = null;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: vi.fn(async () => undefined),
			},
		});

		apiMocks.loadGithubIdentitySession.mockReset();
		apiMocks.cancelGithubIdentityConnect.mockReset();
		apiMocks.listenGithubIdentityChanged.mockReset();
		apiMocks.disconnectGithubIdentity.mockReset();
		apiMocks.loadWorkspaceGroups.mockReset();
		apiMocks.loadArchivedWorkspaces.mockReset();
		apiMocks.loadAgentModelSections.mockReset();
		apiMocks.listRepositories.mockReset();
		apiMocks.loadWorkspaceDetail.mockReset();
		apiMocks.loadWorkspaceSessions.mockReset();
		apiMocks.loadSessionMessages.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();
		apiMocks.loadSessionAttachments.mockReset();
		openerMocks.openUrl.mockReset();

		apiMocks.loadGithubIdentitySession.mockResolvedValue({
			status: "disconnected",
		});
		apiMocks.cancelGithubIdentityConnect.mockResolvedValue(undefined);
		apiMocks.disconnectGithubIdentity.mockResolvedValue(undefined);
		apiMocks.listenGithubIdentityChanged.mockImplementation(
			async (callback) => {
				_identityListener = callback;
				return () => {
					_identityListener = null;
				};
			},
		);

		mockWorkspaceData();
	});

	afterEach(() => {
		removeTauriRuntime();
		cleanup();
	});

	it("renders the shell while GitHub account is disconnected", async () => {
		render(<App />);

		expect(
			await screen.findByRole("main", { name: "GitHub identity gate" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("main", { name: "Application shell" }),
		).not.toBeInTheDocument();
		expect(
			await screen.findByRole("button", { name: "Continue with GitHub" }),
		).toBeInTheDocument();
	});

	it("renders the identity unconfigured state without blocking the shell", async () => {
		apiMocks.loadGithubIdentitySession.mockResolvedValue({
			status: "unconfigured",
			message: "GitHub account connection is not configured.",
		});

		render(<App />);
		expect(
			await screen.findByRole("main", { name: "GitHub identity gate" }),
		).toBeInTheDocument();
		expect(
			await screen.findByText("GitHub account connection is not configured."),
		).toBeInTheDocument();
	});

	it("disconnects the GitHub identity from the account menu", async () => {
		apiMocks.loadGithubIdentitySession.mockResolvedValue({
			status: "connected",
			session: CONNECTED_IDENTITY,
		});

		const user = userEvent.setup();
		render(<App />);

		await screen.findByRole("main", { name: "Application shell" });
		await openGithubMenu();

		await user.click(screen.getByRole("menuitem", { name: "Log out" }));

		await waitFor(() => {
			expect(apiMocks.disconnectGithubIdentity).toHaveBeenCalled();
		});

		expect(
			await screen.findByRole("main", { name: "GitHub identity gate" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Continue with GitHub" }),
		).toBeInTheDocument();
	});

	it("uses a compact GitHub trigger in the toolbar", async () => {
		apiMocks.loadGithubIdentitySession.mockResolvedValue({
			status: "connected",
			session: CONNECTED_IDENTITY,
		});

		render(<App />);

		await screen.findByRole("main", { name: "Application shell" });
		expect(
			screen.getByRole("button", { name: "GitHub account menu" }),
		).toHaveTextContent("caspian");
	});
});
