import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SerializedEditorState } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import { createHelmorQueryClient } from "@/lib/query-client";
import {
	__resetDraftCacheForTests,
	loadPersistedDraft,
	savePersistedDraft,
} from "./draft-storage";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		// Drafts are now DB-backed; the in-memory cache is the
		// source-of-truth in tests (no real Rust IPC). Returning sane
		// defaults for the two draft commands keeps the cache plumbing
		// happy without touching the assertions.
		if (cmd === "list_session_drafts") return [];
		if (cmd === "set_session_draft") return undefined;
		return undefined;
	}),
	convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
}));

/** Match the legacy `localStorage` `.toContain()` assertion shape so
 *  callers can keep reading "the persisted blob contains text X" without
 *  reaching into Lexical's editor-state JSON manually. */
function persistedDraftText(contextKey: string): string {
	const state = loadPersistedDraft(contextKey);
	return state ? JSON.stringify(state) : "";
}

/** Build a minimal Lexical `SerializedEditorState` from one paragraph
 *  of plain text — keeps the test fixture short. The cast through
 *  `unknown` is unavoidable: Lexical's `SerializedEditorState` includes
 *  union types that require `format` to be a specific bit-flag literal,
 *  but the editor's deserializer only checks structural shape — and we
 *  want every test to keep using the same plain string for clarity. */
function paragraphDraft(text: string): SerializedEditorState {
	return {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: null,
			children: [
				{
					type: "paragraph",
					version: 1,
					format: "",
					indent: 0,
					direction: null,
					textFormat: 0,
					textStyle: "",
					children: [
						{
							type: "text",
							version: 1,
							text,
							format: 0,
							mode: "normal",
							style: "",
							detail: 0,
						},
					],
				},
			],
		},
	} as unknown as SerializedEditorState;
}

const openerMocks = vi.hoisted(() => ({
	openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: openerMocks.openUrl,
}));

vi.mock("./composer-editor/plugins/file-mention-plugin", () => ({
	FileMentionPlugin: () => null,
}));

vi.mock("./composer-editor/plugins/slash-command-plugin", () => ({
	SlashCommandPlugin: () => null,
}));

vi.mock("@/components/ai/code-block", () => ({
	CodeBlock: ({ code, language }: { code: string; language?: string }) => (
		<div data-testid="code-block">
			{language ?? "code"}::{code}
		</div>
	),
}));

import { WorkspaceComposer } from "./index";

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	__resetDraftCacheForTests();
	vi.useRealTimers();
});

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
				effortLevels: ["low", "medium", "high", "max"],
				supportsFastMode: true,
			},
		],
	},
] satisfies import("@/lib/api").AgentModelSection[];

function createAskUserQuestionDeferredTool(): PendingDeferredTool {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		permissionMode: "default",
		toolUseId: "tool-ask-1",
		toolName: "AskUserQuestion",
		toolInput: {
			questions: [
				{
					header: "UI",
					question: "Which UI path should we take?",
					options: [
						{
							label: "Patch existing",
							description: "Keep the current layout and patch the flow.",
						},
						{
							label: "Build new",
							description: "Create a dedicated approval surface.",
							preview: "<div>New approval panel</div>",
						},
					],
				},
				{
					header: "Checks",
					question: "Which checks should run before merge?",
					multiSelect: true,
					options: [
						{
							label: "Vitest",
							description: "Run the frontend test suite.",
						},
						{
							label: "Typecheck",
							description: "Run the repository typecheck.",
						},
					],
				},
			],
			metadata: {
				source: "planner",
			},
		},
	};
}

function createGenericDeferredTool(): PendingDeferredTool {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		permissionMode: "default",
		toolUseId: "tool-generic-1",
		toolName: "Bash",
		toolInput: {
			command: "git status --short",
		},
	};
}

function createFormElicitation(): PendingElicitation {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		elicitationId: "elicitation-form-1",
		serverName: "design-server",
		message: "Tell the MCP server what to do next.",
		mode: "form",
		requestedSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					title: "Project name",
					description: "Used for the next step.",
				},
				approved: {
					type: "boolean",
					title: "Approved",
				},
			},
			required: ["name", "approved"],
		},
	};
}

function createUrlElicitation(): PendingElicitation {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		elicitationId: "elicitation-url-1",
		serverName: "auth-server",
		message: "Finish sign-in in the browser.",
		mode: "url",
		url: "https://example.com/authorize",
		requestedSchema: null,
	};
}

describe("WorkspaceComposer", () => {
	afterEach(() => {
		openerMocks.openUrl.mockReset();
	});

	it("renders custom tag insertions as badges and expands them on submit", async () => {
		const queryClient = createHelmorQueryClient();
		const handleSubmit = vi.fn();
		const handleConsumed = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={handleSubmit}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingInsertRequests={[
						{
							id: "insert-1",
							workspaceId: "workspace-1",
							sessionId: "session-1",
							behavior: "append",
							createdAt: 0,
							items: [
								{
									kind: "custom-tag",
									key: "tag-1",
									label: "Requirements",
									submitText:
										"Please implement the full requirements document.",
								},
							],
						},
					]}
					onPendingInsertRequestsConsumed={handleConsumed}
				/>
			</QueryClientProvider>,
		);

		await screen.findByText("Requirements");
		await waitFor(() => {
			expect(handleConsumed).toHaveBeenCalledWith(["insert-1"]);
			expect(screen.getByLabelText("Send")).toBeEnabled();
		});

		fireEvent.click(screen.getByLabelText("Send"));

		expect(handleSubmit).toHaveBeenCalledWith(
			"Please implement the full requirements document.",
			[],
			[],
			[
				{
					id: "tag-1",
					label: "Requirements",
					submitText: "Please implement the full requirements document.",
				},
			],
			expect.objectContaining({
				editorStateSnapshot: expect.objectContaining({
					root: expect.any(Object),
				}),
			}),
		);
	});

	it("persists drafts to the in-memory cache and restores them after remount", async () => {
		const queryClient = createHelmorQueryClient();
		const handleSubmit = vi.fn();
		const contextKey = "session:session-restore";
		const { unmount } = render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-restore"
					onSubmit={handleSubmit}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingInsertRequests={[
						{
							id: "persist-insert-1",
							workspaceId: "workspace-1",
							sessionId: "session-restore",
							behavior: "append",
							createdAt: 0,
							items: [
								{
									kind: "custom-tag",
									key: "persist-tag-1",
									label: "Requirements",
									submitText: "Restore this draft after restart.",
								},
							],
						},
					]}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(persistedDraftText(contextKey)).toContain(
				"Restore this draft after restart.",
			);
		});

		unmount();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-restore"
					onSubmit={handleSubmit}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
				/>
			</QueryClientProvider>,
		);

		await screen.findByText("Requirements");
		expect(persistedDraftText(contextKey)).toContain(
			"Restore this draft after restart.",
		);
		expect(handleSubmit).not.toHaveBeenCalled();
	});

	it("clears persisted drafts after submit", async () => {
		const queryClient = createHelmorQueryClient();
		const handleSubmit = vi.fn();
		const contextKey = "session:session-send";

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey={contextKey}
					onSubmit={handleSubmit}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingInsertRequests={[
						{
							id: "persist-insert-2",
							workspaceId: "workspace-1",
							sessionId: "session-send",
							behavior: "append",
							createdAt: 0,
							items: [
								{
									kind: "custom-tag",
									key: "persist-tag-2",
									label: "Requirements",
									submitText: "Send this persisted draft.",
								},
							],
						},
					]}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(persistedDraftText(contextKey)).toContain(
				"Send this persisted draft.",
			);
		});

		fireEvent.click(screen.getByLabelText("Send"));

		expect(handleSubmit).toHaveBeenCalledWith(
			"Send this persisted draft.",
			[],
			[],
			[
				{
					id: "persist-tag-2",
					label: "Requirements",
					submitText: "Send this persisted draft.",
				},
			],
			expect.objectContaining({
				editorStateSnapshot: expect.objectContaining({
					root: expect.any(Object),
				}),
			}),
		);
		expect(loadPersistedDraft(contextKey)).toBeNull();
	});

	it("does not rehydrate the active draft when restore props change in-place", async () => {
		const queryClient = createHelmorQueryClient();
		const stableContextKey = "session:session-stable";
		savePersistedDraft(
			stableContextKey,
			paragraphDraft("Keep the persisted draft."),
		);
		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey={stableContextKey}
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreDraft="stale restore payload"
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(persistedDraftText(stableContextKey)).toContain(
				"Keep the persisted draft.",
			);
		});

		rerender(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey={stableContextKey}
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreDraft="stale restore payload"
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
				/>
			</QueryClientProvider>,
		);

		expect(persistedDraftText(stableContextKey)).not.toContain(
			"stale restore payload",
		);
		expect(persistedDraftText(stableContextKey)).toContain(
			"Keep the persisted draft.",
		);
	});

	it("does not rehydrate stale local drafts on same-context rerenders", async () => {
		const queryClient = createHelmorQueryClient();
		const contextKey = "session:session-rerender";
		savePersistedDraft(contextKey, paragraphDraft("stale draft"));

		const renderComposer = (
			pendingInsertRequests = [] as Array<{
				id: string;
				workspaceId: string;
				sessionId: string | null;
				items: import("@/lib/composer-insert").ComposerInsertItem[];
				behavior: "append";
				createdAt: number;
			}>,
		) => (
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey={contextKey}
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingInsertRequests={pendingInsertRequests}
				/>
			</QueryClientProvider>
		);

		const { rerender } = render(
			renderComposer([
				{
					id: "insert-rerender-1",
					workspaceId: "workspace-1",
					sessionId: "session-rerender",
					behavior: "append",
					createdAt: 0,
					items: [
						{
							kind: "custom-tag",
							key: "rerender-tag-1",
							label: "New context",
							submitText: "Fresh insert",
						},
					],
				},
			]),
		);

		await screen.findByText("New context");

		rerender(renderComposer());

		expect(screen.getByText("New context")).toBeInTheDocument();
		expect(persistedDraftText(contextKey)).toContain("stale draft");
	});

	it("only renders fast mode controls for supported models", () => {
		const queryClient = createHelmorQueryClient();
		const { rerender } = render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={queryClient}>
					<WorkspaceComposer
						contextKey="session:session-1"
						onSubmit={vi.fn()}
						disabled={false}
						submitDisabled={false}
						sending={false}
						selectedModelId="opus-1m"
						modelSections={[
							...MODEL_SECTIONS,
							{
								id: "codex",
								label: "Codex",
								options: [
									{
										id: "custom-nofast",
										provider: "codex",
										label: "Custom",
										cliModel: "custom-nofast",
										effortLevels: ["low", "medium"],
										supportsFastMode: false,
									},
								],
							},
						]}
						onSelectModel={vi.fn()}
						provider="claude"
						effortLevel="high"
						onSelectEffort={vi.fn()}
						permissionMode="acceptEdits"
						onChangePermissionMode={vi.fn()}
						fastMode={false}
						onChangeFastMode={vi.fn()}
						restoreImages={[]}
						restoreFiles={[]}
						restoreCustomTags={[]}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		expect(screen.getByLabelText("Fast mode")).toBeInTheDocument();

		rerender(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={queryClient}>
					<WorkspaceComposer
						contextKey="session:session-1"
						onSubmit={vi.fn()}
						disabled={false}
						submitDisabled={false}
						sending={false}
						selectedModelId="custom-nofast"
						modelSections={[
							...MODEL_SECTIONS,
							{
								id: "codex",
								label: "Codex",
								options: [
									{
										id: "custom-nofast",
										provider: "codex",
										label: "Custom",
										cliModel: "custom-nofast",
										effortLevels: ["low", "medium"],
										supportsFastMode: false,
									},
								],
							},
						]}
						onSelectModel={vi.fn()}
						provider="codex"
						effortLevel="high"
						onSelectEffort={vi.fn()}
						permissionMode="acceptEdits"
						onChangePermissionMode={vi.fn()}
						fastMode={false}
						onChangeFastMode={vi.fn()}
						restoreImages={[]}
						restoreFiles={[]}
						restoreCustomTags={[]}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		expect(screen.queryByLabelText("Fast mode")).not.toBeInTheDocument();
	});

	it("renders the fast mode lottie overlay only during the fast prelude", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={queryClient}>
					<WorkspaceComposer
						contextKey="session:session-1"
						onSubmit={vi.fn()}
						disabled={false}
						submitDisabled={false}
						sending={false}
						selectedModelId="opus-1m"
						modelSections={MODEL_SECTIONS}
						onSelectModel={vi.fn()}
						provider="claude"
						effortLevel="high"
						onSelectEffort={vi.fn()}
						permissionMode="acceptEdits"
						onChangePermissionMode={vi.fn()}
						fastMode
						showFastModePrelude
						onChangeFastMode={vi.fn()}
						restoreImages={[]}
						restoreFiles={[]}
						restoreCustomTags={[]}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const fastModeButton = screen.getByRole("button", { name: "Fast mode" });
		const overlay = fastModeButton.querySelector(
			"[data-testid='fast-mode-lottie-icon']",
		);
		const zapIcon = fastModeButton.querySelector("svg");

		expect(overlay).not.toBeNull();
		expect(overlay).toHaveClass("absolute", "inset-[-5px]", "z-10");
		expect(zapIcon).not.toHaveClass("opacity-55");
	});

	it("does not render the fast mode lottie overlay when fast mode is only toggled on", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={queryClient}>
					<WorkspaceComposer
						contextKey="session:session-1"
						onSubmit={vi.fn()}
						disabled={false}
						submitDisabled={false}
						sending={false}
						selectedModelId="opus-1m"
						modelSections={MODEL_SECTIONS}
						onSelectModel={vi.fn()}
						provider="claude"
						effortLevel="high"
						onSelectEffort={vi.fn()}
						permissionMode="acceptEdits"
						onChangePermissionMode={vi.fn()}
						fastMode
						onChangeFastMode={vi.fn()}
						restoreImages={[]}
						restoreFiles={[]}
						restoreCustomTags={[]}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const fastModeButton = screen.getByRole("button", { name: "Fast mode" });
		const overlay = fastModeButton.querySelector(
			"[data-testid='fast-mode-lottie-icon']",
		);
		const zapIcon = fastModeButton.querySelector("svg");

		expect(overlay).toBeNull();
		expect(zapIcon).not.toHaveClass("opacity-55");
	});

	it("only dims the fast mode lightning icon when disabled", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<TooltipProvider delayDuration={0}>
				<QueryClientProvider client={queryClient}>
					<WorkspaceComposer
						contextKey="session:session-1"
						onSubmit={vi.fn()}
						disabled={false}
						submitDisabled={false}
						sending={false}
						selectedModelId="opus-1m"
						modelSections={MODEL_SECTIONS}
						onSelectModel={vi.fn()}
						provider="claude"
						effortLevel="high"
						onSelectEffort={vi.fn()}
						permissionMode="acceptEdits"
						onChangePermissionMode={vi.fn()}
						fastMode={false}
						onChangeFastMode={vi.fn()}
						restoreImages={[]}
						restoreFiles={[]}
						restoreCustomTags={[]}
					/>
				</QueryClientProvider>
			</TooltipProvider>,
		);

		const fastModeButton = screen.getByRole("button", { name: "Fast mode" });
		const overlay = fastModeButton.querySelector(
			"[data-testid='fast-mode-lottie-icon']",
		);
		const zapIcon = fastModeButton.querySelector("svg");

		expect(overlay).toBeNull();
		expect(zapIcon).toHaveClass("opacity-55");
	});

	it("shows a hover preview for inserted image badges", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingInsertRequests={[
						{
							id: "insert-image-1",
							workspaceId: "workspace-1",
							sessionId: "session-1",
							behavior: "append",
							createdAt: 0,
							items: [{ kind: "image", path: "/tmp/CleanShot.png" }],
						},
					]}
					onPendingInsertRequestsConsumed={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		const badge = await screen.findByText("CleanShot.png");
		await user.hover(badge);

		expect(
			await screen.findByRole("img", { name: "CleanShot.png" }),
		).toHaveAttribute("src", "asset://localhost/tmp/CleanShot.png");
	});

	it("shows a code preview for inserted custom tag badges", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingInsertRequests={[
						{
							id: "insert-code-1",
							workspaceId: "workspace-1",
							sessionId: "session-1",
							behavior: "append",
							createdAt: 0,
							items: [
								{
									kind: "custom-tag",
									key: "tag-code-1",
									label: "Failure log",
									submitText: "Investigate the failure log.",
									preview: {
										kind: "code",
										title: "Failure log",
										language: "log",
										code: "Error: request failed",
									},
								},
							],
						},
					]}
					onPendingInsertRequestsConsumed={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		const badge = await screen.findByText("Failure log");
		await user.hover(badge);

		expect(await screen.findByTestId("code-block")).toHaveTextContent(
			"log::Error: request failed",
		);
	});

	it("collects AskUserQuestion answers into updatedInput and resumes via allow", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();
		const handleDeferredToolResponse = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingDeferredTool={createAskUserQuestionDeferredTool()}
					onDeferredToolResponse={handleDeferredToolResponse}
				/>
			</QueryClientProvider>,
		);

		expect(screen.queryByText("Claude Needs Input")).not.toBeInTheDocument();
		expect(
			screen.getByText("Which UI path should we take?"),
		).toBeInTheDocument();
		expect(screen.getByText("Choose one option.")).toBeInTheDocument();
		expect(
			screen.queryByText(/deferred tool call can resume/i),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /Build new/i }));
		expect(
			screen.getByText("Which checks should run before merge?"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("tab", { name: "UI" }));
		await user.type(
			screen.getByLabelText("Optional note for Claude"),
			"Prefer the dedicated approval surface.",
		);
		expect(screen.getByLabelText("Optional note for Claude")).toHaveValue(
			"Prefer the dedicated approval surface.",
		);
		await user.click(screen.getByRole("tab", { name: "Checks" }));
		expect(screen.getByText("Choose one or more options.")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Vitest/i }));
		await user.click(screen.getByRole("button", { name: /Typecheck/i }));
		await user.click(screen.getByRole("button", { name: "Send Answers" }));

		expect(handleDeferredToolResponse).toHaveBeenCalledWith(
			expect.objectContaining({ toolUseId: "tool-ask-1" }),
			"allow",
			expect.objectContaining({
				updatedInput: expect.objectContaining({
					answers: {
						"Which UI path should we take?": "Build new",
						"Which checks should run before merge?": "Vitest, Typecheck",
					},
					annotations: {
						"Which UI path should we take?": {
							preview: "<div>New approval panel</div>",
							notes: "Prefer the dedicated approval surface.",
						},
					},
				}),
			}),
		);
	});

	it("keeps deferred tool approval buttons enabled while the stream is paused for approval", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();
		const handleDeferredToolResponse = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={true}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingDeferredTool={createGenericDeferredTool()}
					onDeferredToolResponse={handleDeferredToolResponse}
				/>
			</QueryClientProvider>,
		);

		const allowButton = screen.getByRole("button", { name: "Allow" });
		const denyButton = screen.getByRole("button", { name: "Deny" });

		expect(allowButton).toBeEnabled();
		expect(denyButton).toBeEnabled();

		await user.click(allowButton);

		expect(handleDeferredToolResponse).toHaveBeenCalledWith(
			expect.objectContaining({ toolUseId: "tool-generic-1" }),
			"allow",
			expect.objectContaining({
				updatedInput: {
					command: "git status --short",
				},
			}),
		);
	});

	it("edits custom AskUserQuestion answers inline inside the Other row", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingDeferredTool={createAskUserQuestionDeferredTool()}
					onDeferredToolResponse={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		expect(
			screen.queryByText("Write a custom answer directly in this row."),
		).not.toBeInTheDocument();

		const inlineInput = screen.getByLabelText("Other answer for UI");
		expect(inlineInput).toHaveAttribute("placeholder", "Other");

		const otherRow = inlineInput.closest('[data-ask-option-row="other"]');
		expect(otherRow).not.toBeNull();

		await user.click(otherRow!);
		expect(inlineInput.closest('[data-ask-option-row="other"]')).not.toBeNull();

		await user.type(inlineInput, "Prototype a compact approval surface");
		expect(inlineInput).toHaveValue("Prototype a compact approval surface");
	});

	it("renders a form elicitation panel and submits structured content", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();
		const onElicitationResponse = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingElicitation={createFormElicitation()}
					onElicitationResponse={onElicitationResponse}
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByPlaceholderText("Project name")).toBeInTheDocument();
		expect(
			screen.queryByText("This field is required."),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Send Response" }),
		).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: "Send" }),
		).not.toBeInTheDocument();

		await user.type(
			screen.getByPlaceholderText("Project name"),
			"Helmor Elicitation",
		);
		expect(
			screen.getByRole("button", { name: "Send Response" }),
		).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Next field" }));
		await user.click(screen.getByRole("button", { name: "Yes" }));
		expect(
			screen.getByRole("button", { name: "Send Response" }),
		).not.toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Send Response" }));

		expect(onElicitationResponse).toHaveBeenCalledWith(
			expect.objectContaining({ elicitationId: "elicitation-form-1" }),
			"accept",
			{ approved: true, name: "Helmor Elicitation" },
		);
	});

	it("opens and copies URL elicitation links through the shared panel shell", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();
		const onElicitationResponse = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		openerMocks.openUrl.mockResolvedValue(undefined);

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingElicitation={createUrlElicitation()}
					onElicitationResponse={onElicitationResponse}
				/>
			</QueryClientProvider>,
		);

		expect(
			screen.getByText("Finish sign-in in the browser."),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Copy Link" }));
		expect(writeText).toHaveBeenCalledWith("https://example.com/authorize");

		await user.click(screen.getByRole("button", { name: "Open Link" }));

		expect(openerMocks.openUrl).toHaveBeenCalledWith(
			"https://example.com/authorize",
		);
		await waitFor(() => {
			expect(onElicitationResponse).toHaveBeenCalledWith(
				expect.objectContaining({ elicitationId: "elicitation-url-1" }),
				"accept",
			);
		});
	});

	it("shows Approve and Request Changes buttons when ExitPlanMode permission is pending", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="plan"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		expect(
			screen.getByRole("button", { name: "Implement" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Request Changes" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Send" }),
		).not.toBeInTheDocument();
	});

	it("calls onSubmit with bypassPermissions when Implement is clicked", async () => {
		const queryClient = createHelmorQueryClient();
		const onSubmit = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={onSubmit}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="plan"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Implement" }));

		expect(onSubmit).toHaveBeenCalledWith(
			"Go ahead with the plan.",
			[],
			[],
			[],
			{ permissionModeOverride: "bypassPermissions" },
		);
	});

	it("disables Request Changes when input is empty", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="plan"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		expect(
			screen.getByRole("button", { name: "Request Changes" }),
		).toBeDisabled();
	});

	it("shows plan review placeholder when plan is captured", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="plan"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByText(/Describe what to change/)).toBeInTheDocument();
	});

	it("keeps plan review controls visible while plan review is active", async () => {
		const queryClient = createHelmorQueryClient();
		const onChangePermissionMode = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={true}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="plan"
					onChangePermissionMode={onChangePermissionMode}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		expect(
			screen.getByRole("button", { name: "Implement" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Plan mode" }),
		).not.toBeDisabled();
		expect(onChangePermissionMode).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Send" }),
		).not.toBeInTheDocument();
	});

	it("switches permission mode and submits when Implement is clicked", async () => {
		const queryClient = createHelmorQueryClient();
		const onChangePermissionMode = vi.fn();
		const onSubmit = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={onSubmit}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="plan"
					onChangePermissionMode={onChangePermissionMode}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Implement" }));

		expect(onChangePermissionMode).toHaveBeenCalledWith("bypassPermissions");
		expect(onSubmit).toHaveBeenCalledWith(
			"Go ahead with the plan.",
			[],
			[],
			[],
			{ permissionModeOverride: "bypassPermissions" },
		);
	});

	it("shows normal Send button when hasPlanReview but permissionMode is not plan", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="bypassPermissions"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Implement" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Request Changes" }),
		).not.toBeInTheDocument();
	});

	it("shows normal placeholder when hasPlanReview but permissionMode is not plan", () => {
		const queryClient = createHelmorQueryClient();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="bypassPermissions"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		expect(
			screen.queryByText(/Describe what to change/),
		).not.toBeInTheDocument();
		expect(screen.getByText(/Ask to make changes/)).toBeInTheDocument();
	});

	it("plan toggle button is freely clickable during plan review", async () => {
		const queryClient = createHelmorQueryClient();
		const onChangePermissionMode = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="plan"
					onChangePermissionMode={onChangePermissionMode}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					hasPlanReview
				/>
			</QueryClientProvider>,
		);

		const planButton = screen.getByRole("button", { name: "Plan mode" });
		expect(planButton).not.toBeDisabled();

		await userEvent.click(planButton);
		expect(onChangePermissionMode).toHaveBeenCalledWith("bypassPermissions");
	});
});
