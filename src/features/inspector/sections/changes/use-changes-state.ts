// Toggle state for the four collapsible regions of the Changes section
// (Changes header, Staged, Branch Diff) plus the two tree/flat view
// toggles. Stable callbacks keep the derived changes model memoizable.
import { useCallback, useState } from "react";

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
	const toggleChangesOpen = useCallback(
		() => setChangesOpen((current) => !current),
		[],
	);
	const toggleStagedOpen = useCallback(
		() => setStagedOpen((current) => !current),
		[],
	);
	const toggleBranchDiffOpen = useCallback(
		() => setBranchDiffOpen((current) => !current),
		[],
	);
	const toggleChangesTreeView = useCallback(
		() => setChangesTreeView((current) => !current),
		[],
	);
	const toggleBranchDiffTreeView = useCallback(
		() => setBranchDiffTreeView((current) => !current),
		[],
	);

	return {
		changesOpen,
		stagedOpen,
		branchDiffOpen,
		changesTreeView,
		branchDiffTreeView,
		toggleChangesOpen,
		toggleStagedOpen,
		toggleBranchDiffOpen,
		toggleChangesTreeView,
		toggleBranchDiffTreeView,
	};
}
