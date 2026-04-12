import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import { createHelmorQueryClient } from "@/lib/query-client";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
	convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
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
});

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
				badge: null,
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

function createExitPlanModeDeferredTool(): PendingDeferredTool {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		permissionMode: "plan",
		toolUseId: "tool-plan-1",
		toolName: "ExitPlanMode",
		toolInput: {
			plan: "1. Add the deferred tool panel.\n2. Wire resume-only continuation.\n3. Add coverage.",
			planFilePath: "/tmp/helmor/.claude/plan.md",
			allowedPrompts: [
				{
					tool: "Bash",
					prompt: "run tests",
				},
			],
		},
	};
}

describe("WorkspaceComposer", () => {
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
					onTogglePlanMode={vi.fn()}
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
		);
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
					onTogglePlanMode={vi.fn()}
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
					onTogglePlanMode={vi.fn()}
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
					onTogglePlanMode={vi.fn()}
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
		await user.click(screen.getByRole("button", { name: "UI" }));
		await user.type(
			screen.getByLabelText("Optional note for Claude"),
			"Prefer the dedicated approval surface.{enter}Keep it compact.",
		);
		expect(screen.getByLabelText("Optional note for Claude")).toHaveValue(
			"Prefer the dedicated approval surface.\nKeep it compact.",
		);
		await user.click(screen.getByRole("button", { name: "Checks" }));
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
							notes: "Prefer the dedicated approval surface.\nKeep it compact.",
						},
					},
				}),
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
					onTogglePlanMode={vi.fn()}
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

	it("approves ExitPlanMode with the original tool input", async () => {
		const user = userEvent.setup();
		const queryClient = createHelmorQueryClient();
		const handleDeferredToolResponse = vi.fn();
		const deferred = createExitPlanModeDeferredTool();

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
					onTogglePlanMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingDeferredTool={deferred}
					onDeferredToolResponse={handleDeferredToolResponse}
				/>
			</QueryClientProvider>,
		);

		await user.click(screen.getByRole("button", { name: "Approve Plan" }));

		expect(handleDeferredToolResponse).toHaveBeenCalledWith(deferred, "allow", {
			updatedInput: deferred.toolInput,
		});
	});

	it("sends ExitPlanMode feedback through deny for plan revisions", async () => {
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
					permissionMode="plan"
					onTogglePlanMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingDeferredTool={createExitPlanModeDeferredTool()}
					onDeferredToolResponse={handleDeferredToolResponse}
				/>
			</QueryClientProvider>,
		);

		await user.type(
			screen.getByLabelText("Plan feedback"),
			"Split the validation and resume-flow work into separate commits.",
		);
		await user.click(screen.getByRole("button", { name: "Request Changes" }));

		expect(handleDeferredToolResponse).toHaveBeenCalledWith(
			expect.objectContaining({ toolUseId: "tool-plan-1" }),
			"deny",
			{
				reason:
					"Split the validation and resume-flow work into separate commits.",
			},
		);
	});
});
