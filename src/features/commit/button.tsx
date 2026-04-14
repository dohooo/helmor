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
	className?: string;
	onCommit?: () => void | Promise<void>;
	onStateChange?: (nextState: CommitButtonState) => void;
}

const STATE_LABELS: Record<
	WorkspaceCommitButtonMode,
	Record<CommitButtonState, string>
> = {
	"create-pr": {
		idle: "Create PR",
		busy: "Creating PR...",
		done: "PR Created",
		error: "Retry",
		disabled: "Create PR",
	},
	"commit-and-push": {
		idle: "Commit and Push",
		busy: "Committing...",
		done: "Pushed",
		error: "Retry",
		disabled: "Commit and Push",
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
	"open-pr": {
		idle: "Open PR",
		busy: "Opening PR...",
		done: "Opened",
		error: "Retry",
		disabled: "Open PR",
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

function getDefaultMenuItems(
	mode: WorkspaceCommitButtonMode,
): WorkspaceCommitAction[] {
	if (mode === "commit-and-push") {
		return [
			{
				id: "commit-and-push-manually",
				label: "Commit and push manually",
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
			label: "Create draft PR",
		},
		{
			id: "create-pr-manually",
			label: "Create PR manually",
		},
	];
}

type ActionButtonVariant = "default" | "secondary" | "outline" | "destructive";

function getButtonVariant(
	mode: WorkspaceCommitButtonMode,
): ActionButtonVariant {
	switch (mode) {
		case "fix":
		case "closed":
		case "merge":
		case "merged":
			return "default";
		default:
			return "outline";
	}
}

/** Mode-specific button color overrides (layered on top of the variant). */
function getModeClassName(mode: WorkspaceCommitButtonMode): string | undefined {
	switch (mode) {
		case "fix":
		case "closed":
			return "bg-[var(--workspace-pr-closed-accent)] text-white hover:bg-[var(--workspace-pr-closed-accent)]";
		case "merge":
			return "bg-[var(--workspace-pr-open-accent)] text-white hover:bg-[var(--workspace-pr-open-accent)]";
		case "merged":
			return "bg-[var(--workspace-pr-merged-accent)] text-white hover:bg-[var(--workspace-pr-merged-accent)]";
		default:
			return undefined;
	}
}

function getModeIcon(mode: WorkspaceCommitButtonMode) {
	switch (mode) {
		case "create-pr":
			return null;
		case "commit-and-push":
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
	const buttonVariant = getButtonVariant(mode);
	const modeClassName = getModeClassName(mode);

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

	const resolvedMenuItems = menuItems ?? getDefaultMenuItems(mode);
	const hasMenuItems =
		mode !== "fix" &&
		mode !== "resolve-conflicts" &&
		mode !== "merge" &&
		mode !== "open-pr" &&
		mode !== "merged" &&
		mode !== "closed" &&
		resolvedMenuItems.length > 0;
	const mainText = mainLabel ?? STATE_LABELS[mode][currentState];
	const mainIcon = getModeIcon(mode);
	const optionsAriaLabel =
		mode === "commit-and-push"
			? "Commit and push options"
			: mode === "fix"
				? "Fix CI options"
				: mode === "resolve-conflicts"
					? "Resolve conflicts options"
					: mode === "merge"
						? "Merge options"
						: mode === "open-pr"
							? "Open PR options"
							: mode === "merged"
								? "Merged options"
								: mode === "closed"
									? "Closed options"
									: "Create PR options";

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
						className="text-[11px]"
					>
						{item.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default WorkspaceCommitButton;
