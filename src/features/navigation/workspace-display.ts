import type { WorkspaceRow } from "@/lib/api";
import { humanizeBranch } from "./shared";

export type WorkspaceDisplay = {
	title: string;
	subtitle: string | null;
	branch: string | null;
	prTitle: string | null;
};

// Title priority: PR title > primary session > active session > humanized branch > row.title.
export function deriveWorkspaceDisplay(row: WorkspaceRow): WorkspaceDisplay {
	const branch = row.branch ?? null;
	const repoLabel = row.repoName ?? row.directoryName ?? null;
	const subtitle = repoLabel
		? branch
			? `${repoLabel} › ${branch}`
			: repoLabel
		: branch;

	const trimmedPrTitle = row.prTitle?.trim() || null;
	const primarySessionTitle =
		row.primarySessionTitle && row.primarySessionTitle !== "Untitled"
			? row.primarySessionTitle
			: null;
	const activeSessionTitle =
		row.activeSessionTitle && row.activeSessionTitle !== "Untitled"
			? row.activeSessionTitle
			: null;

	const title =
		trimmedPrTitle ??
		primarySessionTitle ??
		activeSessionTitle ??
		(branch ? humanizeBranch(branch) : row.title);

	return { title, subtitle, branch, prTitle: trimmedPrTitle };
}
