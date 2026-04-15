import { Github } from "@lobehub/icons";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	type CommitButtonState,
	WorkspaceCommitButton,
	type WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import type { PullRequestInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
	getGitSectionHeaderHighlightClass,
	INSPECTOR_SECTION_HEADER_CLASS,
	INSPECTOR_SECTION_TITLE_CLASS,
} from "../layout";

export type GitSectionHeaderProps = {
	commitButtonMode: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	prInfo: PullRequestInfo | null;
	hasChanges?: boolean;
	onPrClick?: () => void;
	onCommit?: () => void | Promise<void>;
	className?: string;
};

export function GitSectionHeader({
	commitButtonMode,
	commitButtonState,
	prInfo,
	hasChanges = false,
	onPrClick,
	onCommit,
	className,
}: GitSectionHeaderProps) {
	const gitHeaderHighlightClass =
		getGitSectionHeaderHighlightClass(commitButtonMode);

	const showButton =
		hasChanges ||
		commitButtonState === "busy" ||
		commitButtonMode !== "create-pr";

	return (
		<div
			className={cn(
				INSPECTOR_SECTION_HEADER_CLASS,
				gitHeaderHighlightClass,
				className,
			)}
		>
			<div className="flex min-w-0 items-center gap-1.5">
				{!prInfo ? (
					<span className={cn(INSPECTOR_SECTION_TITLE_CLASS, "translate-y-px")}>
						Git
					</span>
				) : (
					<Button
						type="button"
						variant="outline"
						size="xs"
						className={cn(
							"self-center translate-y-px bg-transparent font-normal tracking-[0.01em] hover:bg-transparent hover:opacity-80",
							(commitButtonMode === "fix" || commitButtonMode === "closed") &&
								"border-[var(--workspace-pr-closed-accent)] text-[var(--workspace-pr-closed-accent)] hover:text-[var(--workspace-pr-closed-accent)]",
							commitButtonMode === "resolve-conflicts" &&
								"border-[var(--workspace-pr-conflicts-accent)] text-[var(--workspace-pr-conflicts-accent)] hover:text-[var(--workspace-pr-conflicts-accent)]",
							commitButtonMode === "merge" &&
								"border-[var(--workspace-pr-open-accent)] text-[var(--workspace-pr-open-accent)] hover:text-[var(--workspace-pr-open-accent)]",
							commitButtonMode === "merged" &&
								"border-[var(--workspace-pr-merged-accent)] text-[var(--workspace-pr-merged-accent)] hover:text-[var(--workspace-pr-merged-accent)]",
						)}
						onClick={onPrClick}
					>
						<span className="inline-flex items-center gap-1.5 leading-none">
							<Github size={12} className="shrink-0 self-center" />
							<span className="inline-flex items-center leading-none tabular-nums text-sm font-light">
								#{prInfo.number}
							</span>
							<ExternalLink
								size={12}
								strokeWidth={2}
								className="shrink-0 self-center"
							/>
						</span>
					</Button>
				)}
			</div>
			{showButton && (
				<WorkspaceCommitButton
					mode={commitButtonMode}
					state={commitButtonState}
					className="ml-auto self-center translate-y-px"
					onCommit={onCommit}
				/>
			)}
		</div>
	);
}
