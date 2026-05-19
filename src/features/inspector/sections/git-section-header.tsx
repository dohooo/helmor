import { ChevronsRight, ExternalLink } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	type CommitButtonState,
	getCommitButtonLabel,
	WorkspaceCommitButton,
	type WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import { getShortcut } from "@/features/shortcuts/registry";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { ShortcutId } from "@/features/shortcuts/types";
import type {
	ChangeRequestInfo,
	ForgeActionStatus,
	ForgeDetection,
} from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { useMinDisplayDuration } from "@/lib/use-min-display-duration";
import { cn } from "@/lib/utils";
import {
	getGitSectionHeaderHighlightClass,
	INSPECTOR_SECTION_HEADER_CLASS,
	INSPECTOR_SECTION_TITLE_CLASS,
} from "../layout";
import { ForgeCliTrigger } from "./forge-cli-onboarding";

const SHIMMER_MIN_DISPLAY_MS = 1500;
const CONTINUE_LABEL = "Continue";
const CONTINUE_BUTTON_PADDING_X_PX = 8;
const CONTINUE_BUTTON_GAP_PX = 4;
const CONTINUE_ICON_SIZE_PX = 13;
const CONTINUE_LABEL_FALLBACK_WIDTH_PX = 45;
const getContinueFullWidth = (labelWidth: number) =>
	CONTINUE_BUTTON_PADDING_X_PX * 2 +
	CONTINUE_ICON_SIZE_PX +
	CONTINUE_BUTTON_GAP_PX +
	labelWidth;
const CONTINUE_ICON_WIDTH_PX =
	CONTINUE_BUTTON_PADDING_X_PX * 2 + CONTINUE_ICON_SIZE_PX;
const CONTINUE_COMPACT_THRESHOLD_PX =
	CONTINUE_ICON_WIDTH_PX + CONTINUE_BUTTON_GAP_PX + 12;

function getShortcutIdForCommitMode(
	mode: WorkspaceCommitButtonMode,
): ShortcutId | null {
	switch (mode) {
		case "create-pr":
			return "action.createPr";
		case "commit-and-push":
			return "action.commitAndPush";
		case "fix":
		case "resolve-conflicts":
			return "action.fixErrors";
		case "checks-running":
		case "merge-blocked":
		case "merge":
			return "action.mergePr";
		default:
			return null;
	}
}

export type GitSectionHeaderProps = {
	commitButtonMode: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	changeRequest: ChangeRequestInfo | null;
	hasChanges?: boolean;
	/**
	 * Whether change request data is currently being (re)fetched. Drives the
	 * bottom shimmer bar (combined with `commitButtonState === "disabled"`).
	 * Gated by a min display duration so fast responses don't flicker.
	 *
	 * Scope: ONLY first cold fetch — owned by App. Background polling does
	 * not flip this true (would be visually noisy).
	 */
	isRefreshing?: boolean;
	changeRequestName?: string;
	forgeRemoteState?: ForgeActionStatus["remoteState"] | null;
	/**
	 * Full forge classification for the current workspace. When CLI setup
	 * needs attention, we swap the Create PR button for one forge connect CTA.
	 */
	forgeDetection?: ForgeDetection | null;
	workspaceId?: string | null;
	onChangeRequestClick?: () => void;
	onCommit?: () => void | Promise<void>;
	onContinueWorkspace?: () => void | Promise<void>;
	isContinuingWorkspace?: boolean;
	className?: string;
};

export function GitSectionHeader({
	commitButtonMode,
	commitButtonState,
	changeRequest,
	hasChanges = false,
	isRefreshing = false,
	changeRequestName = "PR",
	forgeRemoteState = null,
	forgeDetection = null,
	workspaceId = null,
	onChangeRequestClick,
	onCommit,
	onContinueWorkspace,
	isContinuingWorkspace = false,
	className,
}: GitSectionHeaderProps) {
	const { settings } = useSettings();
	const gitHeaderHighlightClass =
		getGitSectionHeaderHighlightClass(commitButtonMode);
	const commitShortcutId = getShortcutIdForCommitMode(commitButtonMode);
	const commitShortcut = commitShortcutId
		? getShortcut(settings.shortcuts, commitShortcutId)
		: null;
	const openChangeRequestShortcut = getShortcut(
		settings.shortcuts,
		"action.openPullRequest",
	);

	// Shimmer fires while the header is in a transient "computing" state that
	// directly affects what the user can do:
	//   1. First cold fetch of PR / forge-action data (`isRefreshing`).
	//   2. The commit button is `disabled` because GitHub is still computing
	//      mergeability (`mergeable === "UNKNOWN"`). Without this cue, a
	//      grayed-out merge button looks broken — the user can't tell whether
	//      it's a transient sync or a permanent block.
	// We deliberately do NOT shimmer for:
	//   - Background polling on stable data (would be noisy).
	//   - Active lifecycle phases (creating/streaming/verifying) — the button
	//     itself shows a busy spinner, additional shimmer is redundant.
	const [forgeConnecting, setForgeConnecting] = useState(false);
	const isComputing =
		isRefreshing || commitButtonState === "disabled" || forgeConnecting;
	const showShimmer = useMinDisplayDuration(
		isComputing,
		SHIMMER_MIN_DISPLAY_MS,
	);

	// Per-repo auth state is the source of truth in the multi-account
	// architecture: `forgeRemoteState` already covers both "no accounts
	// at all" (per-repo lookup fails because there's nothing to bind)
	// and "this repo's bound account is broken". The legacy
	// `cliStatus.status === "unauthenticated"` clause was redundant
	// global-state plumbing.
	const showForgeOnboarding =
		forgeRemoteState === "unauthenticated" && forgeDetection !== null;
	useEffect(() => {
		if (!showForgeOnboarding) {
			setForgeConnecting(false);
		}
	}, [showForgeOnboarding]);
	const showButton =
		hasChanges ||
		commitButtonState === "busy" ||
		commitButtonMode !== "create-pr" ||
		showForgeOnboarding;
	const isMergeRequest = forgeDetection?.provider === "gitlab";
	const showChangeRequest = changeRequest !== null && !showForgeOnboarding;
	const showContinue = commitButtonMode === "merged" && showChangeRequest;
	const headerRef = useRef<HTMLDivElement | null>(null);
	const changeRequestRef = useRef<HTMLDivElement | null>(null);
	const commitButtonRef = useRef<HTMLDivElement | null>(null);
	const continueLabelRef = useRef<HTMLSpanElement | null>(null);
	const [continueLabelWidth, setContinueLabelWidth] = useState(
		CONTINUE_LABEL_FALLBACK_WIDTH_PX,
	);
	const continueFullWidth = getContinueFullWidth(continueLabelWidth);
	const [continueWidth, setContinueWidth] = useState(continueFullWidth);
	const iconMarginLeft =
		CONTINUE_BUTTON_PADDING_X_PX +
		((continueFullWidth - continueWidth) /
			(continueFullWidth - CONTINUE_ICON_WIDTH_PX)) *
			((CONTINUE_ICON_WIDTH_PX - CONTINUE_ICON_SIZE_PX) / 2 -
				CONTINUE_BUTTON_PADDING_X_PX);
	const labelMaxWidth = Math.max(
		0,
		continueWidth -
			iconMarginLeft -
			CONTINUE_ICON_SIZE_PX -
			CONTINUE_BUTTON_GAP_PX -
			CONTINUE_BUTTON_PADDING_X_PX,
	);

	useLayoutEffect(() => {
		if (!showContinue || !showButton || typeof ResizeObserver === "undefined") {
			setContinueWidth(continueFullWidth);
			return;
		}

		const measure = () => {
			const header = headerRef.current;
			const changeRequestButton = changeRequestRef.current;
			const commitButton = commitButtonRef.current;
			if (!header || !changeRequestButton || !commitButton) return;

			const labelWidth = continueLabelRef.current?.scrollWidth;
			if (
				typeof labelWidth === "number" &&
				Math.abs(labelWidth - continueLabelWidth) > 0.5
			) {
				setContinueLabelWidth(labelWidth);
			}

			const styles = window.getComputedStyle(header);
			const contentWidth =
				header.clientWidth -
				Number.parseFloat(styles.paddingLeft || "0") -
				Number.parseFloat(styles.paddingRight || "0");
			const headerGap = Number.parseFloat(styles.columnGap || "0");
			const actionGap = Number.parseFloat(
				window.getComputedStyle(commitButton.parentElement ?? header)
					.columnGap || "0",
			);
			const availableForContinue =
				contentWidth -
				changeRequestButton.offsetWidth -
				commitButton.offsetWidth -
				headerGap -
				actionGap;
			const compact = availableForContinue < CONTINUE_COMPACT_THRESHOLD_PX;

			setContinueWidth(
				compact
					? CONTINUE_ICON_WIDTH_PX
					: Math.min(
							continueFullWidth,
							Math.max(CONTINUE_COMPACT_THRESHOLD_PX, availableForContinue),
						),
			);
		};

		const observer = new ResizeObserver(measure);
		for (const element of [
			headerRef.current,
			changeRequestRef.current,
			commitButtonRef.current,
		]) {
			if (element) observer.observe(element);
		}
		measure();
		return () => observer.disconnect();
	}, [showContinue, showButton, continueFullWidth, continueLabelWidth]);

	return (
		<div
			ref={headerRef}
			className={cn(
				INSPECTOR_SECTION_HEADER_CLASS,
				"relative gap-1.5 overflow-hidden border-b-0 shadow-[inset_0_-1px_0_color-mix(in_oklch,var(--border)_60%,transparent)]",
				"transition-[background-color,border-color,color,box-shadow] duration-300 ease-out",
				showForgeOnboarding ? null : gitHeaderHighlightClass,
				className,
			)}
		>
			{showShimmer && (
				<div
					data-testid="git-header-shimmer"
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 bottom-0 h-px motion-safe:animate-[shine_2s_infinite_linear]"
					style={{
						backgroundImage:
							"linear-gradient(90deg, transparent 0%, transparent 35%, color-mix(in oklch, var(--color-primary) 50%, transparent) 50%, transparent 65%, transparent 100%)",
						backgroundSize: "300% 100%",
					}}
				/>
			)}
			<div
				ref={changeRequestRef}
				className="flex shrink-0 items-center gap-1.5"
			>
				{!showChangeRequest ? (
					<span className={cn(INSPECTOR_SECTION_TITLE_CLASS, "translate-y-px")}>
						Git
					</span>
				) : (
					(() => {
						const button = (
							<Button
								type="button"
								variant="outline"
								size="xs"
								className={cn(
									"self-center rounded-md bg-transparent font-normal tracking-[0.01em] transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-transparent hover:opacity-80",
									(commitButtonMode === "fix" ||
										commitButtonMode === "merge-blocked" ||
										commitButtonMode === "closed") &&
										"border-[var(--workspace-pr-closed-accent)] text-[var(--workspace-pr-closed-accent)] hover:text-[var(--workspace-pr-closed-accent)]",
									commitButtonMode === "resolve-conflicts" &&
										"border-[var(--workspace-pr-conflicts-accent)] text-[var(--workspace-pr-conflicts-accent)] hover:text-[var(--workspace-pr-conflicts-accent)]",
									commitButtonMode === "checks-running" &&
										"border-[var(--workspace-pr-checks-running-accent)] text-[var(--workspace-pr-checks-running-accent)] hover:text-[var(--workspace-pr-checks-running-accent)]",
									commitButtonMode === "merge" &&
										"border-[var(--workspace-pr-open-accent)] text-[var(--workspace-pr-open-accent)] hover:text-[var(--workspace-pr-open-accent)]",
									commitButtonMode === "merged" &&
										"border-[var(--workspace-pr-merged-accent)] text-[var(--workspace-pr-merged-accent)] hover:text-[var(--workspace-pr-merged-accent)]",
								)}
								onClick={onChangeRequestClick}
							>
								<span className="inline-flex h-4 min-w-0 items-center gap-1.5 leading-4">
									<span className="inline-flex size-4 shrink-0 items-center justify-center overflow-visible">
										{isMergeRequest ? (
											<GitlabBrandIcon size={12} />
										) : (
											<GithubBrandIcon size={12} />
										)}
									</span>
									<span className="inline-flex h-4 min-w-0 items-center truncate leading-4 tabular-nums text-[13px] font-light">
										{isMergeRequest ? "!" : "#"}
										{changeRequest.number}
									</span>
									<ExternalLink
										size={12}
										strokeWidth={2}
										className="shrink-0 self-center"
									/>
								</span>
							</Button>
						);
						const openLabel = isMergeRequest
							? "Open merge request"
							: "Open pull request";
						return (
							<Tooltip>
								<TooltipTrigger asChild>{button}</TooltipTrigger>
								<TooltipContent
									side="bottom"
									className="flex max-w-[320px] items-center gap-2 rounded-md px-2 py-1 text-[12px] leading-tight"
								>
									<span className="truncate">{openLabel}</span>
									{openChangeRequestShortcut ? (
										<InlineShortcutDisplay hotkey={openChangeRequestShortcut} />
									) : null}
								</TooltipContent>
							</Tooltip>
						);
					})()
				)}
			</div>
			{showButton &&
				(showForgeOnboarding ? (
					<ForgeCliTrigger
						detection={forgeDetection}
						workspaceId={workspaceId}
						connecting={forgeConnecting}
						onConnectingChange={setForgeConnecting}
					/>
				) : (
					<div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
						{showContinue && (
							<Button
								type="button"
								variant="outline"
								size="xs"
								aria-label="Continue workspace"
								className={cn(
									"shrink-0 justify-start overflow-hidden self-center rounded-md border-dashed border-[var(--workspace-pr-merged-accent)] bg-transparent px-0 font-normal text-[var(--workspace-pr-merged-accent)] transition-[background-color,border-color,color,box-shadow,opacity] duration-200 ease-out hover:bg-transparent hover:text-[var(--workspace-pr-merged-accent)] hover:opacity-80",
								)}
								style={{ width: continueWidth }}
								disabled={isContinuingWorkspace}
								onClick={onContinueWorkspace}
							>
								<ChevronsRight
									size={13}
									strokeWidth={2}
									className="shrink-0 transition-[margin-left] duration-200 ease-out"
									style={{ marginLeft: iconMarginLeft }}
								/>
								<span
									ref={continueLabelRef}
									className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left leading-none"
									style={{ maxWidth: labelMaxWidth }}
								>
									{CONTINUE_LABEL}
								</span>
							</Button>
						)}
						<div ref={commitButtonRef} className="flex shrink-0 items-center">
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="inline-flex">
										<WorkspaceCommitButton
											mode={commitButtonMode}
											state={commitButtonState}
											changeRequestName={changeRequestName}
											className="self-center rounded-md"
											onCommit={onCommit}
										/>
									</span>
								</TooltipTrigger>
								{commitShortcut ? (
									<TooltipContent
										side="bottom"
										className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
									>
										<span>
											{getCommitButtonLabel(
												commitButtonMode,
												"idle",
												changeRequestName,
											)}
										</span>
										<InlineShortcutDisplay
											hotkey={commitShortcut}
											className="text-background/60"
										/>
									</TooltipContent>
								) : null}
							</Tooltip>
						</div>
					</div>
				))}
		</div>
	);
}
