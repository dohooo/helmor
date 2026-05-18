/**
 * Visual reference for the composer interaction surfaces:
 *
 *   - Default: Lexical editor + toolbar
 *   - State A: Permission request — `PermissionPanel` (its own wire event +
 *              RPC; uses the shared `ToolApprovalCard` for rendering)
 *   - State B: Ask-user-question — `UserInputPanel` routes to the
 *              AskUserQuestion sub-renderer based on `payload.kind =
 *              "ask-user-question"` (Claude AUQ / multi-question
 *              format)
 *   - State C: Form / URL user-input — `UserInputPanel` routes to the
 *              ElicitationRenderer based on `payload.kind = "form" |
 *              "url"` (covers MCP elicitations and Codex's synthesized
 *              user-input form)
 *
 * The stories render the real production components with mocked prop
 * values — no JSX is reimplemented here. If the app's styling changes,
 * these previews change automatically.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PendingPermission } from "@/features/conversation/hooks/use-streaming";
import type { PendingUserInput } from "@/features/conversation/pending-user-input";
import type { AgentModelSection } from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";
import { WorkspaceComposer } from "./index";

// ── Mock fixtures ─────────────────────────────────────────────────────
// Shapes copied from the real streaming payloads (see tests in
// `composer/index.test.tsx` for the upstream reference).

const MODEL_SECTIONS: AgentModelSection[] = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "sonnet-4-5",
				provider: "claude",
				label: "Sonnet 4.5",
				cliModel: "claude-sonnet-4-5",
				effortLevels: ["low", "medium", "high", "max"],
				supportsFastMode: true,
			},
		],
	},
];

const MOCK_PERMISSION: PendingPermission = {
	permissionId: "perm-mock-1",
	toolName: "Bash",
	toolInput: {
		command: "rm -f /Users/kevin/nix-config/.git/hooks/post-checkout",
	},
	title: null,
	description: null,
};

const MOCK_FORM_USER_INPUT: PendingUserInput = {
	provider: "claude",
	modelId: "sonnet-4-5",
	resolvedModel: "claude-sonnet-4-5",
	providerSessionId: null,
	workingDirectory: "/tmp/helmor",
	permissionMode: null,
	userInputId: "user-input-mock-form",
	source: "vercel",
	message: "Configure the new deployment target.",
	payload: {
		kind: "form",
		schema: {
			type: "object",
			properties: {
				projectName: {
					type: "string",
					title: "Project name",
					description: "Human-friendly name shown in the dashboard.",
					minLength: 1,
					maxLength: 64,
				},
				port: {
					type: "integer",
					title: "Port",
					description: "Port the dev server should bind to.",
					minimum: 1,
					maximum: 65535,
					default: 3000,
				},
				environment: {
					type: "string",
					title: "Environment",
					description: "Which environment to deploy into.",
					enum: ["development", "staging", "production"],
					enumNames: ["Development", "Staging", "Production"],
				},
				autoDeploy: {
					type: "boolean",
					title: "Auto-deploy on push",
					description: "Automatically redeploy when main changes.",
					default: false,
				},
			},
			required: ["projectName", "environment"],
		},
	},
};

const MOCK_URL_USER_INPUT: PendingUserInput = {
	provider: "claude",
	modelId: "sonnet-4-5",
	resolvedModel: "claude-sonnet-4-5",
	providerSessionId: null,
	workingDirectory: "/tmp/helmor",
	permissionMode: null,
	userInputId: "user-input-mock-url",
	source: "auth-server",
	message: "Finish signing in in the browser to continue.",
	payload: {
		kind: "url",
		url: "https://example.com/oauth/authorize?client_id=helmor&state=abc",
	},
};

const MOCK_ASK_USER_QUESTION: PendingUserInput = {
	provider: "claude",
	modelId: "sonnet-4-5",
	resolvedModel: "claude-sonnet-4-5",
	providerSessionId: null,
	workingDirectory: "/tmp/helmor",
	permissionMode: null,
	userInputId: "tool-ask-1",
	source: "Claude",
	message: "Claude is asking for your input.",
	payload: {
		kind: "ask-user-question",
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
					},
				],
			},
			{
				header: "Checks",
				question: "Which checks should run before merge?",
				multiSelect: true,
				options: [
					{ label: "Vitest", description: "Run the frontend test suite." },
					{ label: "Typecheck", description: "Run the repository typecheck." },
				],
			},
		],
	},
};

// ── Shared composer prop defaults ─────────────────────────────────────
// The real app wires these through `WorkspaceComposerContainer`; here we
// provide the minimal set so `<WorkspaceComposer>` renders faithfully.

type ComposerProps = React.ComponentProps<typeof WorkspaceComposer>;

function baseComposerProps(contextKey: string): ComposerProps {
	return {
		contextKey,
		onSubmit: () => {},
		onStop: () => {},
		sending: false,
		selectedModelId: "sonnet-4-5",
		modelSections: MODEL_SECTIONS,
		modelsLoading: false,
		onSelectModel: () => {},
		provider: "claude",
		effortLevel: "high",
		onSelectEffort: () => {},
		permissionMode: "acceptEdits",
		onChangePermissionMode: () => {},
		fastMode: false,
		onChangeFastMode: () => {},
		restoreDraft: null,
		restoreImages: [],
		restoreFiles: [],
		restoreCustomTags: [],
		restoreNonce: 0,
		slashCommands: [],
		workspaceRootPath: "/tmp/helmor",
		pendingUserInput: null,
		pendingPermission: null,
		hasPlanReview: false,
	};
}

// ── Story harness ─────────────────────────────────────────────────────
// Wraps previews in the same providers the real App.tsx uses so queries
// and Radix tooltips resolve without errors.

let sharedQueryClient: QueryClient | null = null;
function getQueryClient(): QueryClient {
	if (sharedQueryClient == null) {
		sharedQueryClient = createHelmorQueryClient();
	}
	return sharedQueryClient;
}

function Harness({
	children,
	label,
	width = 720,
}: {
	children: ReactNode;
	label: string;
	width?: number;
}) {
	return (
		<div
			className="flex flex-col gap-2"
			style={{ width: `${width}px`, maxWidth: "100%" }}
		>
			<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
				{label}
			</div>
			{/*
			 * `mt-auto px-4 pb-4 pt-0` + the wrapping `<div>` copy the layout
			 * from `conversation/index.tsx` so the permission bar's `-mb-px`
			 * overlap with the composer is reproduced exactly.
			 */}
			<div className="mt-auto px-4 pb-4 pt-0">
				<div>{children}</div>
			</div>
		</div>
	);
}

function withProviders(story: () => ReactNode) {
	return (
		<QueryClientProvider client={getQueryClient()}>
			<TooltipProvider>{story()}</TooltipProvider>
		</QueryClientProvider>
	);
}

// ── Meta ──────────────────────────────────────────────────────────────

const meta: Meta = {
	title: "Features/Composer/Interaction States",
	parameters: {
		layout: "fullscreen",
	},
	tags: ["autodocs"],
};

export default meta;

type Story = StoryObj;

// ── Stories ───────────────────────────────────────────────────────────
// Each story renders the *real* WorkspaceComposer — the only difference
// between states is which mock fixture (if any) is supplied as a prop.

export const Default: Story = {
	render: () =>
		withProviders(() => (
			<Harness label="Default — Lexical editor + toolbar">
				<WorkspaceComposer {...baseComposerProps("story:default")} />
			</Harness>
		)),
};

export const StateAPermissionPanel: Story = {
	name: "A — Permission request",
	render: () =>
		withProviders(() => (
			<Harness label="A — Permission request panel">
				<WorkspaceComposer
					{...baseComposerProps("story:permission")}
					pendingPermission={MOCK_PERMISSION}
				/>
			</Harness>
		)),
};

export const StateBAskUserQuestion: Story = {
	name: "B — Ask user question",
	render: () =>
		withProviders(() => (
			<Harness label="B — AskUserQuestion user-input panel">
				<WorkspaceComposer
					{...baseComposerProps("story:ask-user-question")}
					pendingUserInput={MOCK_ASK_USER_QUESTION}
				/>
			</Harness>
		)),
};

export const StateCFormUserInput: Story = {
	name: "C — Form user input",
	render: () =>
		withProviders(() => (
			<Harness label="C — Form user-input panel (MCP / Codex form)">
				<WorkspaceComposer
					{...baseComposerProps("story:form-user-input")}
					pendingUserInput={MOCK_FORM_USER_INPUT}
				/>
			</Harness>
		)),
};

export const StateCUrlUserInput: Story = {
	name: "C — URL user input",
	render: () =>
		withProviders(() => (
			<Harness label="C — URL user-input panel">
				<WorkspaceComposer
					{...baseComposerProps("story:url-user-input")}
					pendingUserInput={MOCK_URL_USER_INPUT}
				/>
			</Harness>
		)),
};

export const AllStates: Story = {
	name: "All states (grid)",
	render: () =>
		withProviders(() => (
			// `maxHeight: 100dvh` + `overflow-y-auto` lets the grid scroll when the
			// combined height of the harnesses exceeds the Storybook canvas
			// (which is fixed to the viewport because the meta uses
			// `layout: "fullscreen"`). Without this the overflowing harnesses at
			// the bottom get clipped.
			<div
				className="flex flex-wrap items-start gap-8 overflow-y-auto p-6"
				style={{ maxHeight: "100dvh" }}
			>
				<Harness label="Default" width={560}>
					<WorkspaceComposer {...baseComposerProps("story:grid-default")} />
				</Harness>
				<Harness label="A — Permission request" width={560}>
					<WorkspaceComposer
						{...baseComposerProps("story:grid-permission")}
						pendingPermission={MOCK_PERMISSION}
					/>
				</Harness>
				<Harness label="B — Ask user question" width={560}>
					<WorkspaceComposer
						{...baseComposerProps("story:grid-ask-user-question")}
						pendingUserInput={MOCK_ASK_USER_QUESTION}
					/>
				</Harness>
				<Harness label="C — Form user input" width={560}>
					<WorkspaceComposer
						{...baseComposerProps("story:grid-form-user-input")}
						pendingUserInput={MOCK_FORM_USER_INPUT}
					/>
				</Harness>
				<Harness label="C — URL user input" width={560}>
					<WorkspaceComposer
						{...baseComposerProps("story:grid-url-user-input")}
						pendingUserInput={MOCK_URL_USER_INPUT}
					/>
				</Harness>
			</div>
		)),
};
