import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import type { ChangeRequestInfo } from "@/lib/api";
import { GitSectionHeader } from "./git-section-header";

// ── Mock data ─────────────────────────────────────────────────────────

const CHANGE_REQUEST_OPEN: ChangeRequestInfo = {
	url: "https://github.com/helmor/helmor/pull/42",
	number: 42,
	state: "OPEN",
	title: "feat: add workspace git sync",
	isMerged: false,
};

const CHANGE_REQUEST_MERGED: ChangeRequestInfo = {
	url: "https://github.com/helmor/helmor/pull/42",
	number: 42,
	state: "MERGED",
	title: "feat: add workspace git sync",
	isMerged: true,
};

const CHANGE_REQUEST_CLOSED: ChangeRequestInfo = {
	url: "https://github.com/helmor/helmor/pull/42",
	number: 42,
	state: "CLOSED",
	title: "feat: add workspace git sync",
	isMerged: false,
};

// ── Lookup helpers ────────────────────────────────────────────────────

function changeRequestForMode(
	mode: WorkspaceCommitButtonMode,
): ChangeRequestInfo | null {
	switch (mode) {
		case "create-pr":
			return null;
		case "commit-and-push":
		case "push":
		case "resolve-conflicts":
		case "checks-running":
		case "merge-blocked":
		case "merge":
		case "fix":
			return CHANGE_REQUEST_OPEN;
		case "merged":
			return CHANGE_REQUEST_MERGED;
		case "closed":
		case "open-pr":
			return CHANGE_REQUEST_CLOSED;
	}
}

function hasChangesForMode(mode: WorkspaceCommitButtonMode): boolean {
	return mode === "create-pr" || mode === "commit-and-push" || mode === "push";
}

// ── Constants ─────────────────────────────────────────────────────────

const ALL_MODES: WorkspaceCommitButtonMode[] = [
	"create-pr",
	"commit-and-push",
	"push",
	"resolve-conflicts",
	"fix",
	"checks-running",
	"merge-blocked",
	"merge",
	"merged",
	"closed",
	"open-pr",
];

const ALL_STATES: CommitButtonState[] = [
	"idle",
	"busy",
	"done",
	"error",
	"disabled",
];

const MODE_LABELS: Record<WorkspaceCommitButtonMode, string> = {
	"create-pr": "Create PR",
	"commit-and-push": "Commit & Push",
	push: "Push",
	"resolve-conflicts": "Resolve Conflicts",
	fix: "Fix CI",
	"checks-running": "Checks Running",
	"merge-blocked": "Merge Blocked",
	merge: "Merge",
	merged: "Merged",
	closed: "Closed",
	"open-pr": "Open PR",
};

const STATE_LABELS: Record<CommitButtonState, string> = {
	idle: "Normal",
	busy: "Loading",
	done: "Done",
	error: "Error",
	disabled: "Disabled",
};

// ── Cell: mirrors the real <section> wrapper from changes.tsx ─────────

const PANEL_WIDTH = 300;

function HeaderCell({
	mode,
	state,
}: {
	mode: WorkspaceCommitButtonMode;
	state: CommitButtonState;
}) {
	return (
		<section
			className="flex min-h-0 flex-col overflow-hidden bg-sidebar"
			style={{ width: PANEL_WIDTH }}
		>
			<GitSectionHeader
				commitButtonMode={mode}
				commitButtonState={state}
				changeRequest={changeRequestForMode(mode)}
				hasChanges={hasChangesForMode(mode)}
				className="border-b-0"
			/>
		</section>
	);
}

// ── Meta ──────────────────────────────────────────────────────────────

const meta = {
	title: "Inspector/GitSectionHeader",
	component: GitSectionHeader,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
	},
	argTypes: {
		commitButtonMode: {
			control: "select",
			options: ALL_MODES,
		},
		commitButtonState: {
			control: "select",
			options: ALL_STATES,
		},
		hasChanges: { control: "boolean" },
	},
} satisfies Meta<typeof GitSectionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEFAULT: State Matrix (first story = first page)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const StateMatrix: Story = {
	name: "All States",
	args: {
		commitButtonMode: "create-pr",
		commitButtonState: "idle",
		changeRequest: null,
	},
	render: () => (
		<div style={{ padding: 32, overflow: "auto" }}>
			{/* Column headers */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: `120px repeat(${ALL_STATES.length}, ${PANEL_WIDTH}px)`,
					gap: "0 16px",
					marginBottom: 6,
				}}
			>
				<div />
				{ALL_STATES.map((s) => (
					<div
						key={s}
						style={{
							fontSize: 10,
							fontWeight: 700,
							textTransform: "uppercase",
							letterSpacing: "0.06em",
							color: "var(--muted-foreground)",
						}}
					>
						{STATE_LABELS[s]}
					</div>
				))}
			</div>

			{/* Rows */}
			{ALL_MODES.map((mode) => (
				<div
					key={mode}
					style={{
						display: "grid",
						gridTemplateColumns: `120px repeat(${ALL_STATES.length}, ${PANEL_WIDTH}px)`,
						gap: "0 16px",
						alignItems: "center",
						marginBottom: 6,
					}}
				>
					<div
						style={{
							fontSize: 11,
							fontWeight: 600,
							color: "var(--foreground)",
							whiteSpace: "nowrap",
						}}
					>
						{MODE_LABELS[mode]}
					</div>
					{ALL_STATES.map((state) => (
						<HeaderCell key={`${mode}-${state}`} mode={mode} state={state} />
					))}
				</div>
			))}
		</div>
	),
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Individual interactive stories (for focused tweaking in Controls)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const singleDecorator = (Story: React.ComponentType) => (
	<div style={{ padding: 32 }}>
		<section
			className="flex min-h-0 flex-col overflow-hidden bg-sidebar"
			style={{ width: PANEL_WIDTH }}
		>
			<Story />
		</section>
	</div>
);

export const CreatePR: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "create-pr",
		commitButtonState: "idle",
		changeRequest: null,
		hasChanges: true,
	},
};

export const CommitAndPush: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "commit-and-push",
		commitButtonState: "idle",
		changeRequest: CHANGE_REQUEST_OPEN,
		hasChanges: true,
	},
};

export const ResolveConflicts: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "resolve-conflicts",
		commitButtonState: "idle",
		changeRequest: CHANGE_REQUEST_OPEN,
		hasChanges: false,
	},
};

export const Merge: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "merge",
		commitButtonState: "idle",
		changeRequest: CHANGE_REQUEST_OPEN,
		hasChanges: false,
	},
};

// Captures the case the user complained about: a merge button that's
// visibly disabled because GitHub is still computing mergeability. The
// bottom shimmer signals to the user that this is a transient sync state,
// not a permanent block.
export const MergeComputing: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "merge",
		commitButtonState: "disabled",
		changeRequest: CHANGE_REQUEST_OPEN,
		hasChanges: false,
	},
};

export const Merged: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "merged",
		commitButtonState: "idle",
		changeRequest: CHANGE_REQUEST_MERGED,
		hasChanges: false,
	},
};

export const Closed: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "closed",
		commitButtonState: "idle",
		changeRequest: CHANGE_REQUEST_CLOSED,
		hasChanges: false,
	},
};

export const OpenPR: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "open-pr",
		commitButtonState: "idle",
		changeRequest: CHANGE_REQUEST_CLOSED,
		hasChanges: false,
	},
};

export const FixCI: Story = {
	decorators: [singleDecorator],
	args: {
		commitButtonMode: "fix",
		commitButtonState: "idle",
		changeRequest: CHANGE_REQUEST_OPEN,
		hasChanges: false,
	},
};
