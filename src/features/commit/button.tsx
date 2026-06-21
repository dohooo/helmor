import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	ButtonGroup,
	ButtonGroupSeparator,
} from "@/components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	type MergeBlockedReason,
	mergeBlockedShortLabel,
} from "@/lib/commit-button-logic";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type TFn = (key: string) => string;
type FFn = (key: string, values: Record<string, string | number>) => string;

export type CommitButtonState = "idle" | "busy" | "done" | "error" | "disabled";
export type WorkspaceCommitButtonMode =
	| "create-pr"
	| "commit-and-push"
	| "push"
	| "fix"
	| "resolve-conflicts"
	| "checks-running"
	| "merge-blocked"
	| "merge"
	| "open-pr"
	| "merged"
	| "closed";

export type WorkspaceCommitAction = {
	id: string;
	label: string;
	onClick?: () => void | Promise<void>;
};

interface WorkspaceCommitButtonProps {
	mainLabel?: string;
	mode?: WorkspaceCommitButtonMode;
	disabled?: boolean;
	state?: CommitButtonState;
	doneDurationMs?: number;
	errorDurationMs?: number;
	menuItems?: WorkspaceCommitAction[];
	changeRequestName?: string;
	/** Drives the idle label when `mode === "merge-blocked"`. */
	mergeBlockedReason?: MergeBlockedReason | null;
	className?: string;
	onCommit?: () => void | Promise<void>;
	onStateChange?: (nextState: CommitButtonState) => void;
}

// Values are i18n catalog KEYS, resolved via translateSource in
// getCommitButtonLabel.
const STATIC_STATE_LABELS: Record<
	Exclude<WorkspaceCommitButtonMode, "create-pr" | "open-pr">,
	Record<CommitButtonState, string>
> = {
	"commit-and-push": {
		idle: "commitButtonCommitAndPush",
		busy: "commitButtonCommitting",
		done: "commitButtonPushed",
		error: "retry",
		disabled: "commitButtonCommitAndPush",
	},
	push: {
		idle: "push",
		busy: "commitButtonPushing",
		done: "commitButtonPushed",
		error: "retry",
		disabled: "push",
	},
	fix: {
		idle: "commitButtonFixCi",
		busy: "commitButtonFixingCi",
		done: "commitButtonCiFixed",
		error: "retry",
		disabled: "commitButtonFixCi",
	},
	"resolve-conflicts": {
		idle: "commitButtonResolveConflicts",
		busy: "commitButtonResolving",
		done: "commitButtonResolved",
		error: "retry",
		disabled: "commitButtonResolveConflicts",
	},
	"checks-running": {
		idle: "commitButtonChecksRunning",
		busy: "commitButtonMerging",
		done: "merged",
		error: "retry",
		disabled: "commitButtonChecksRunning",
	},
	"merge-blocked": {
		idle: "commitButtonMergeBlocked",
		busy: "commitButtonMerging",
		done: "merged",
		error: "retry",
		disabled: "commitButtonMergeBlocked",
	},
	merge: {
		idle: "commitButtonMerge",
		busy: "commitButtonMerging",
		done: "merged",
		error: "retry",
		disabled: "commitButtonMerge",
	},
	merged: {
		idle: "merged",
		busy: "merged",
		done: "merged",
		error: "merged",
		disabled: "merged",
	},
	closed: {
		idle: "closed",
		busy: "closed",
		done: "closed",
		error: "closed",
		disabled: "closed",
	},
};

export function getCommitButtonLabel(
	mode: WorkspaceCommitButtonMode,
	state: CommitButtonState,
	changeRequestName: string,
	t: TFn,
	f: FFn,
	mergeBlockedReason?: MergeBlockedReason | null,
): string {
	if (mode === "create-pr") {
		switch (state) {
			case "busy":
				return f("commitButtonCreatingName", {
					name: changeRequestName,
				});
			case "done":
				return f("commitButtonNameCreated", {
					name: changeRequestName,
				});
			case "error":
				return t("retry");
			case "idle":
			case "disabled":
				return f("commitButtonCreateName", {
					name: changeRequestName,
				});
		}
	}
	if (mode === "open-pr") {
		switch (state) {
			case "busy":
				return f("commitButtonOpeningName", {
					name: changeRequestName,
				});
			case "done":
				return t("opened");
			case "error":
				return t("retry");
			case "idle":
			case "disabled":
				return f("commitButtonOpenName", {
					name: changeRequestName,
				});
		}
	}
	// Busy/done/error keep the generic "Merging…" / "Merged" / "Retry".
	if (
		mode === "merge-blocked" &&
		mergeBlockedReason &&
		(state === "idle" || state === "disabled")
	) {
		return mergeBlockedShortLabel(mergeBlockedReason);
	}
	return t(STATIC_STATE_LABELS[mode][state]);
}

function getDefaultMenuItems(
	mode: WorkspaceCommitButtonMode,
	changeRequestName: string,
	t: TFn,
	f: FFn,
): WorkspaceCommitAction[] {
	if (mode === "commit-and-push") {
		return [
			{
				id: "commit-and-push-manually",
				label: t("commitPushManually"),
			},
		];
	}

	if (mode === "push") {
		return [
			{
				id: "push-manually",
				label: t("pushManually"),
			},
		];
	}

	if (mode === "fix") {
		return [
			{
				id: "fix-manually",
				label: t("fixCiManually"),
			},
		];
	}

	return [
		{
			id: "create-draft-pr",
			label: f("commitButtonCreateDraftName", {
				name: changeRequestName,
			}),
		},
		{
			id: "create-pr-manually",
			label: f("commitButtonCreateNameManually", {
				name: changeRequestName,
			}),
		},
	];
}

type ActionButtonVariant = "default" | "secondary" | "outline" | "destructive";

function getButtonVariant(
	mode: WorkspaceCommitButtonMode,
	state: CommitButtonState | undefined,
): ActionButtonVariant {
	// Non-actionable states all share the "muted ghost" look (outline +
	// transparent bg + muted accent), regardless of mode:
	//   • merged / closed — settled ghost (PR finalized).
	//   • merge + disabled — mergeability is still computing.
	// Filled CTA is reserved for actively-actionable modes only.
	if (mode === "merged" || mode === "closed") return "outline";
	if (mode === "merge" && state === "disabled") return "outline";
	switch (mode) {
		case "fix":
		case "resolve-conflicts":
		case "merge":
			return "default";
		case "checks-running":
		case "merge-blocked":
			return "outline";
		default:
			return "outline";
	}
}

/** Mode-specific button color overrides (layered on top of the variant).
 *
 * Two visual families:
 *  - **Filled CTA** for actionable modes (fix / resolve-conflicts / merge).
 *  - **Muted ghost** for non-actionable modes — transparent bg, muted
 *    accent border + text. Used for both settled ghost states (merged /
 *    closed) and the transient merge-disabled state (mergeability still
 *    computing). Keeping these in one shape so wrapper-level opacity
 *    tricks aren't needed.
 */
function getModeClassName(
	mode: WorkspaceCommitButtonMode,
	state: CommitButtonState | undefined,
): string | undefined {
	// Computing mergeability: render the merge button as a green ghost so
	// it visually pairs with merged/closed (and the open-accent PR badge
	// next to it) instead of a faded-out solid CTA.
	if (mode === "merge" && state === "disabled") {
		return "border-[var(--workspace-pr-open-accent)] bg-transparent text-[var(--workspace-pr-open-accent)] transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-transparent hover:text-[var(--workspace-pr-open-accent)]";
	}
	switch (mode) {
		case "fix":
			return "bg-clip-border bg-[var(--workspace-pr-closed-accent)] text-white transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-[var(--workspace-pr-closed-accent)]";
		case "resolve-conflicts":
			return "bg-clip-border bg-[var(--workspace-pr-conflicts-accent)] text-white transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-[var(--workspace-pr-conflicts-accent)]";
		case "checks-running":
			return "border-[var(--workspace-pr-checks-running-accent)] bg-transparent text-[var(--workspace-pr-checks-running-accent)] transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-transparent hover:text-[var(--workspace-pr-checks-running-accent)]";
		case "merge-blocked":
			return "border-[var(--workspace-pr-closed-accent)] bg-transparent text-[var(--workspace-pr-closed-accent)] transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-transparent hover:text-[var(--workspace-pr-closed-accent)]";
		case "merge":
			return "bg-clip-border bg-[var(--workspace-pr-open-accent)] text-white transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-[var(--workspace-pr-open-accent)]";
		// Ghost: outline + transparent + the same pure accent the PR badge
		// and Continue button use, so all three pieces in the bar share
		// one color.
		case "merged":
			return "border-[var(--workspace-pr-merged-accent)] bg-transparent text-[var(--workspace-pr-merged-accent)] transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-transparent hover:text-[var(--workspace-pr-merged-accent)]";
		case "closed":
			return "border-[var(--workspace-pr-closed-accent)] bg-transparent text-[var(--workspace-pr-closed-accent)] transition-[background-color,border-color,color,box-shadow,opacity] duration-300 ease-out hover:bg-transparent hover:text-[var(--workspace-pr-closed-accent)]";
		default:
			return undefined;
	}
}

function getModeIcon(mode: WorkspaceCommitButtonMode) {
	switch (mode) {
		case "create-pr":
			return null;
		case "commit-and-push":
		case "push":
			return null;
		case "fix":
			return null;
		case "resolve-conflicts":
			return null;
		case "checks-running":
			return null;
		case "merge-blocked":
			return null;
		case "merge":
		case "merged":
			return null;
		case "open-pr":
			return null;
		case "closed":
			return null;
	}
}

export function WorkspaceCommitButton({
	mainLabel,
	mode = "create-pr",
	disabled = false,
	state,
	doneDurationMs = 900,
	errorDurationMs = 1200,
	menuItems,
	changeRequestName = "PR",
	mergeBlockedReason = null,
	className,
	onCommit,
	onStateChange,
}: WorkspaceCommitButtonProps) {
	const { t, f } = useI18n();
	const isControlled = state !== undefined;
	const [internalState, setInternalState] = useState<CommitButtonState>(
		disabled ? "disabled" : "idle",
	);
	useEffect(() => {
		if (disabled) {
			setInternalState("disabled");
			return;
		}
		if (!isControlled && internalState === "disabled") {
			setInternalState("idle");
		}
	}, [disabled, isControlled, internalState]);

	const currentState = isControlled ? state : internalState;
	const isBusy = currentState === "busy";
	const isGhostMode = mode === "merged" || mode === "closed";
	const buttonVariant = getButtonVariant(mode, currentState);
	const modeClassName = getModeClassName(mode, currentState);

	const setState = (nextState: CommitButtonState) => {
		onStateChange?.(nextState);
		if (!isControlled) {
			setInternalState(nextState);
		}
	};

	const runAction = (action?: () => void | Promise<void>) => {
		if (currentState === "busy" || currentState === "disabled" || disabled)
			return;

		// Controlled mode: parent drives the state machine across multi-phase
		// flows (e.g. createSession → stream → PR lookup → mode rotation). We
		// just invoke the action and let the parent flip `state` externally.
		if (isControlled) {
			void Promise.resolve().then(() => action?.());
			return;
		}

		setState("busy");

		void Promise.resolve()
			.then(() => action?.())
			.then(() => {
				setState("done");
				setTimeout(() => {
					if (!disabled) {
						setState("idle");
					}
				}, doneDurationMs);
			})
			.catch(() => {
				setState("error");
				setTimeout(() => {
					if (!disabled) {
						setState("idle");
					}
				}, errorDurationMs);
			});
	};

	const resolvedMenuItems =
		menuItems ?? getDefaultMenuItems(mode, changeRequestName, t, f);
	const hasMenuItems =
		mode !== "fix" &&
		mode !== "resolve-conflicts" &&
		mode !== "checks-running" &&
		mode !== "merge-blocked" &&
		mode !== "merge" &&
		mode !== "open-pr" &&
		mode !== "merged" &&
		mode !== "closed" &&
		resolvedMenuItems.length > 0;
	const mainText =
		mainLabel ??
		getCommitButtonLabel(
			mode,
			currentState,
			changeRequestName,
			t,
			f,
			mergeBlockedReason,
		);
	const mainIcon = getModeIcon(mode);
	const optionsAriaLabel =
		mode === "commit-and-push"
			? t("commitButtonCommitAndPushOptions")
			: mode === "push"
				? t("commitButtonPushOptions")
				: mode === "fix"
					? t("commitButtonFixCiOptions")
					: mode === "resolve-conflicts"
						? t("commitButtonResolveConflictsOptions")
						: mode === "checks-running"
							? t("commitButtonChecksRunningOptions")
							: mode === "merge-blocked"
								? t("commitButtonMergeBlockedOptions")
								: mode === "merge"
									? t("commitButtonMergeOptions")
									: mode === "open-pr"
										? f("commitButtonOpenNameOptions", {
												name: changeRequestName,
											})
										: mode === "merged"
											? t("commitButtonMergedOptions")
											: mode === "closed"
												? t("commitButtonClosedOptions")
												: f("commitButtonCreateNameOptions", {
														name: changeRequestName,
													});

	const mainButton = (
		<Button
			type="button"
			size="xs"
			variant={buttonVariant}
			disabled={isBusy || currentState === "disabled" || disabled}
			onClick={isGhostMode ? undefined : () => runAction(onCommit)}
			className={cn(
				"min-w-0",
				modeClassName,
				className,
				isGhostMode && "pointer-events-none",
			)}
		>
			{mainIcon}
			<span>{mainText}</span>
		</Button>
	);

	if (!hasMenuItems) {
		return mainButton;
	}

	return (
		<DropdownMenu>
			<ButtonGroup aria-label={mainText} className={className}>
				<Button
					type="button"
					size="xs"
					variant={buttonVariant}
					disabled={isBusy || currentState === "disabled" || disabled}
					onClick={() => runAction(onCommit)}
					className={cn("min-w-0", modeClassName)}
				>
					{mainIcon}
					<span>{mainText}</span>
				</Button>
				<ButtonGroupSeparator
					orientation="vertical"
					className="bg-primary-foreground/20"
				/>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						size="icon-xs"
						variant={buttonVariant}
						disabled={
							isBusy || currentState === "disabled" || disabled || !hasMenuItems
						}
						aria-label={optionsAriaLabel}
						className={modeClassName}
					>
						<ChevronDown strokeWidth={2.2} />
					</Button>
				</DropdownMenuTrigger>
			</ButtonGroup>
			<DropdownMenuContent align="end" side="bottom" sideOffset={4}>
				{resolvedMenuItems.map((item) => (
					<DropdownMenuItem
						key={item.id}
						onClick={() => runAction(item.onClick)}
					>
						{item.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default WorkspaceCommitButton;
