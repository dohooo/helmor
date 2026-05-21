import type React from "react";
import type {
	ActiveEditorTarget,
	DiffOpenOptions,
	InspectorFileItem,
} from "@/lib/editor-session";

export type StageActionKind = "stage" | "unstage";

/** A change item already projected into a single area's line counts.
 * `insertions`/`deletions` are derived from the corresponding area
 * (staged / unstaged / committed) — never used elsewhere. */
export type ChangeRow = InspectorFileItem & {
	insertions: number;
	deletions: number;
};

export type ChangeGroupId = "staged" | "unstaged" | "branch";

export type ChangeListGroup = {
	id: ChangeGroupId;
	label: string;
	icon?: React.ReactNode;
	count: number;
	open: boolean;
	loading?: boolean;
	changes: ChangeRow[];
	treeView: boolean;
	onToggle: () => void;
	onToggleTreeView: () => void;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onBatchAction?: () => void;
	onDiscard?: (path: string) => void;
	originalRef?: string;
	modifiedRef?: string;
};

export type ChangeListCommonProps = {
	editorMode: boolean;
	activeEditor?: ActiveEditorTarget | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	onOpenExternalEditor: (path: string) => void;
	flashingPaths: Set<string>;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
};
