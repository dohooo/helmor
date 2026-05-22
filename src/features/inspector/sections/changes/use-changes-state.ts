// Toggle state for the four collapsible regions of the Changes section
// (Changes header, Staged, Branch Diff) plus the two tree/flat view
// toggles. Plain boolean state with stable setters so the JSX consumer
// can pass them straight into onClick handlers.
import { useState } from "react";

export type ChangesStateController = {
	changesOpen: boolean;
	stagedOpen: boolean;
	branchDiffOpen: boolean;
	changesTreeView: boolean;
	branchDiffTreeView: boolean;
	toggleChangesOpen(): void;
	toggleStagedOpen(): void;
	toggleBranchDiffOpen(): void;
	toggleChangesTreeView(): void;
	toggleBranchDiffTreeView(): void;
};

export function useChangesState(): ChangesStateController {
	const [changesTreeView, setChangesTreeView] = useState(true);
	const [branchDiffTreeView, setBranchDiffTreeView] = useState(true);
	const [changesOpen, setChangesOpen] = useState(true);
	const [stagedOpen, setStagedOpen] = useState(true);
	const [branchDiffOpen, setBranchDiffOpen] = useState(true);

	return {
		changesOpen,
		stagedOpen,
		branchDiffOpen,
		changesTreeView,
		branchDiffTreeView,
		toggleChangesOpen: () => setChangesOpen((current) => !current),
		toggleStagedOpen: () => setStagedOpen((current) => !current),
		toggleBranchDiffOpen: () => setBranchDiffOpen((current) => !current),
		toggleChangesTreeView: () => setChangesTreeView((v) => !v),
		toggleBranchDiffTreeView: () => setBranchDiffTreeView((v) => !v),
	};
}
