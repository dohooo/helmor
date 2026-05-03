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
import { cn } from "@/lib/utils";

export type CommitButtonState = "idle" | "busy" | "done" | "error" | "disabled";
export type WorkspaceCommitButtonMode =
	| "create-pr"
	| "commit-and-push"
	| "push"
	| "fix"
	| "resolve-conflicts"
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
	className?: string;
	onCommit?: () => void | Promise<void>;
	onStateChange?: (nextState: CommitButtonState) => void;
}

const STATIC_STATE_LABELS: Record<
	Exclude<WorkspaceCommitButtonMode, "create-pr" | "open-pr">,
	Record<CommitButtonState, string>
> = {
	"commit-and-push": {
		idle: "Commit and Push",
		busy: "Committing...",
		done: "Pushed",
		error: "Retry",
		disabled: "Commit and Push",
	},
	push: {
		idle: "Push",
		busy: "Pushing...",
		done: "Pushed",
		error: "Retry",
		disabled: "Push",
	},
	fix: {
		idle: "Fix CI",
		busy: "Fixing CI...",
		done: "CI Fixed",
		error: "Retry",
		disabled: "Fix CI",
	},
	"resolve-conflicts": {
		idle: "Resolve Conflicts",
		busy: "Resolving...",
		done: "Resolved",
		error: "Retry",
		disabled: "Resolve Conflicts",
	},
	merge: {
		idle: "Merge",
		busy: "Merging...",
		done: "Merged",
		error: "Retry",
		disabled: "Merge",
	},
	merged: {
		idle: "Merged",
		busy: "Merged",
		done: "Merged",
		error: "Merged",
		disabled: "Merged",
	},
	closed: {
		idle: "Closed",
		busy: "Closed",
		done: "Closed",
		error: "Closed",
		disabled: "Closed",
	},
};

export function getCommitButtonLabel(
	mode: WorkspaceCommitButtonMode,
	state: CommitButtonState,
	changeRequestName: string,
): string {
	if (mode === "create-pr") {
		switch (state) {
			case "busy":
				return `Creating ${changeRequestName}...`;
			case "done":
				return `${changeRequestName} Created`;
			case "error":
				return "Retry";
			case "idle":
			case "disabled":
				return `Create ${changeRequestName}`;
		}
	}
	if (mode === "open-pr") {
		switch (state) {
			case "busy":
				return `Opening ${changeRequestName}...`;
			case "done":
				return "Opened";
			case "error":
				return "Retry";
			case "idle":
			case "disabled":
				return `Open ${changeRequestName}`;
		}
	}
	return STATIC_STATE_LABELS[mode][state];
}

function getDefaultMenuItems(
	mode: WorkspaceCommitButtonMode,
	changeRequestName: string,
): WorkspaceCommitAction[] {
	if (mode === "commit-and-push") {
		return [
			{
				id: "commit-and-push-manually",
				label: "Commit and push manually",
			},
		];
	}

	if (mode === "push") {
		return [
			{
				id: "push-manually",
				label: "Push manually",
			},
		];
	}

	if (mode === "fix") {
		return [
			{
				id: "fix-manually",
				label: "Fix CI manually",
			},
		];
	}

	return [
		{
			id: "create-draft-pr",
			label: `Create draft ${changeRequestName}`,
		},
		{
			id: "create-pr-manually",
			label: `Create ${changeRequestName} manually`,
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
	className,
	onCommit,
	onStateChange,
}: WorkspaceCommitButtonProps) {
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
		menuItems ?? getDefaultMenuItems(mode, changeRequestName);
	const hasMenuItems =
		mode !== "fix" &&
		mode !== "resolve-conflicts" &&
		mode !== "merge" &&
		mode !== "open-pr" &&
		mode !== "merged" &&
		mode !== "closed" &&
		resolvedMenuItems.length > 0;
	const mainText =
		mainLabel ?? getCommitButtonLabel(mode, currentState, changeRequestName);
	const mainIcon = getModeIcon(mode);
	const optionsAriaLabel =
		mode === "commit-and-push"
			? "Commit and push options"
			: mode === "push"
				? "Push options"
				: mode === "fix"
					? "Fix CI options"
					: mode === "resolve-conflicts"
						? "Resolve conflicts options"
						: mode === "merge"
							? "Merge options"
							: mode === "open-pr"
								? `Open ${changeRequestName} options`
								: mode === "merged"
									? "Merged options"
									: mode === "closed"
										? "Closed options"
										: `Create ${changeRequestName} options`;

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
