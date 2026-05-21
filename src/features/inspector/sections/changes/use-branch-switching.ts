import { useEffect, useRef, useState } from "react";
import type { InspectorFileItem } from "@/lib/editor-session";

export function useBranchSwitching({
	workspaceId,
	workspaceTargetBranch,
	changes,
}: {
	workspaceId: string | null;
	workspaceTargetBranch: string | null;
	changes: InspectorFileItem[];
}) {
	const [branchSwitching, setBranchSwitching] = useState(false);
	const prevTargetRef = useRef(workspaceTargetBranch);
	const prevWorkspaceRef = useRef(workspaceId);
	const switchChangesRef = useRef(changes);

	useEffect(() => {
		const sameWorkspace = prevWorkspaceRef.current === workspaceId;
		prevWorkspaceRef.current = workspaceId;
		const targetChanged = prevTargetRef.current !== workspaceTargetBranch;
		prevTargetRef.current = workspaceTargetBranch;
		if (targetChanged && sameWorkspace) {
			switchChangesRef.current = changes;
			setBranchSwitching(true);
		}
	}, [workspaceId, workspaceTargetBranch, changes]);

	useEffect(() => {
		if (!branchSwitching) return;
		if (changes !== switchChangesRef.current) {
			setBranchSwitching(false);
			return;
		}
		const id = window.setTimeout(() => setBranchSwitching(false), 5000);
		return () => window.clearTimeout(id);
	}, [branchSwitching, changes]);

	return branchSwitching;
}
