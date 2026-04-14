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
					<span className={INSPECTOR_SECTION_TITLE_CLASS}>Git</span>
				) : null}
				{prInfo && (
					<Button
						type="button"
						variant="link"
						className={cn(
							"h-9 self-center rounded-none px-0 py-0 pt-[4px] text-[11px] font-semibold leading-none tracking-[0.01em] no-underline",
							prInfo.isMerged
								? "text-primary hover:text-primary"
								: prInfo.state === "OPEN"
									? "text-[var(--workspace-pr-open-accent)] hover:text-[var(--workspace-pr-open-accent)]"
									: "text-muted-foreground hover:text-foreground",
						)}
						onClick={onPrClick}
					>
						PR #{prInfo.number}
					</Button>
				)}
			</div>
			{showButton && (
				<WorkspaceCommitButton
					mode={commitButtonMode}
					state={commitButtonState}
					className="my-0.5 ml-auto"
					onCommit={onCommit}
				/>
			)}
		</div>
	);
}
