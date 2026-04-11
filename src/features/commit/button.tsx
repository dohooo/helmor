import {
	AlertIcon,
	ArrowUpRightIcon,
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestIcon,
	UploadIcon,
	XCircleFillIcon,
} from "@primer/octicons-react";
import { ChevronDown } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
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

const BUTTON_STYLE =
	"h-5 text-[11px] font-medium leading-none tracking-[0.01em] shadow-none transition-all duration-150";
const BUTTON_ICON_CLASS = "relative -top-px size-[11px] shrink-0 align-middle";

type ButtonColorVars = CSSProperties & {
	"--button-border"?: string;
	"--button-divider"?: string;
	"--button-bg"?: string;
	"--button-bg-hover"?: string;
	"--button-fg"?: string;
	"--button-fg-hover"?: string;
};

function semanticButtonVars(
	role: "success" | "danger" | "attention" | "accent" | "done" | "closed",
	variant: "filled" | "ghost",
): ButtonColorVars {
	const palette = {
		success: "var(--chart-2)",
		danger: "var(--destructive)",
		attention: "var(--chart-4)",
		accent: "var(--chart-3)",
		done: "var(--chart-1)",
		closed: "var(--destructive)",
	}[role];

	if (role === "closed" && variant === "ghost") {
		return {
			"--button-border": `color-mix(in oklch, ${palette} 32%, var(--border) 68%)`,
			"--button-divider": `color-mix(in oklch, ${palette} 18%, transparent)`,
			"--button-bg": "transparent",
			"--button-bg-hover": "transparent",
			"--button-fg": `color-mix(in oklch, ${palette} 52%, var(--muted-foreground) 48%)`,
			"--button-fg-hover": `color-mix(in oklch, ${palette} 52%, var(--muted-foreground) 48%)`,
		};
	}

	if (variant === "ghost") {
		return {
			"--button-border": `color-mix(in oklch, ${palette} 46%, var(--border) 54%)`,
			"--button-divider": `color-mix(in oklch, ${palette} 24%, transparent)`,
			"--button-bg": "transparent",
			"--button-bg-hover": "transparent",
			"--button-fg": `color-mix(in oklch, ${palette} 74%, var(--muted-foreground) 26%)`,
			"--button-fg-hover": `color-mix(in oklch, ${palette} 74%, var(--muted-foreground) 26%)`,
		};
	}

	return {
		"--button-border": `color-mix(in oklch, ${palette} 52%, var(--border) 48%)`,
		"--button-divider": "rgb(0 0 0 / 0.18)",
		"--button-bg": `color-mix(in oklch, ${palette} 34%, var(--background) 66%)`,
		"--button-bg-hover": `color-mix(in oklch, ${palette} 44%, var(--background) 56%)`,
		"--button-fg": "var(--foreground)",
		"--button-fg-hover": "var(--foreground)",
	};
}

function getButtonColorVars(
	mode: WorkspaceCommitButtonMode,
	state: CommitButtonState,
): ButtonColorVars {
	if (mode === "create-pr" && state !== "disabled") {
		return {
			"--button-border": "transparent",
			"--button-divider":
				"color-mix(in oklch, var(--foreground) 22%, transparent)",
			"--button-bg": "var(--foreground)",
			"--button-bg-hover":
				"color-mix(in oklch, var(--foreground) 90%, black 10%)",
			"--button-fg": "var(--background)",
			"--button-fg-hover": "var(--background)",
		};
	}

	if (mode === "merge" && state !== "disabled") {
		return {
			"--button-border": "transparent",
			"--button-divider": "rgb(255 255 255 / 0.18)",
			"--button-bg": "var(--chart-2)",
			"--button-bg-hover": "color-mix(in oklch, var(--chart-2) 90%, black 10%)",
			"--button-fg": "var(--background)",
			"--button-fg-hover": "var(--background)",
		};
	}

	if (mode === "merged" && state !== "disabled") {
		return {
			"--button-border": "transparent",
			"--button-divider": "rgb(255 255 255 / 0.16)",
			"--button-bg": "var(--chart-4)",
			"--button-bg-hover": "color-mix(in oklch, var(--chart-4) 90%, black 10%)",
			"--button-fg": "var(--background)",
			"--button-fg-hover": "var(--background)",
		};
	}

	if (state === "disabled") {
		return {
			"--button-border": "color-mix(in oklch, var(--border) 92%, transparent)",
			"--button-divider": "rgb(0 0 0 / 0.12)",
			"--button-bg":
				"color-mix(in oklch, var(--primary) 72%, var(--muted) 28%)",
			"--button-bg-hover":
				"color-mix(in oklch, var(--primary) 72%, var(--muted) 28%)",
			"--button-fg": "var(--muted-foreground)",
			"--button-fg-hover": "var(--muted-foreground)",
		};
	}
	if (mode === "closed") return semanticButtonVars("closed", "ghost");

	if (mode === "fix") return semanticButtonVars("danger", "filled");
	if (mode === "resolve-conflicts")
		return semanticButtonVars("attention", "filled");
	if (mode === "open-pr") return semanticButtonVars("accent", "filled");
	if (mode === "create-pr" || mode === "commit-and-push" || mode === "merge") {
		return semanticButtonVars("success", "filled");
	}

	return semanticButtonVars("accent", "filled");
}

function getModeIcon(mode: WorkspaceCommitButtonMode) {
	switch (mode) {
		case "create-pr":
			return <GitPullRequestIcon size={11} className={BUTTON_ICON_CLASS} />;
		case "commit-and-push":
			return <UploadIcon size={11} className={BUTTON_ICON_CLASS} />;
		case "fix":
			return <XCircleFillIcon size={11} className={BUTTON_ICON_CLASS} />;
		case "resolve-conflicts":
			return <AlertIcon size={11} className={BUTTON_ICON_CLASS} />;
		case "merge":
		case "merged":
			return <GitMergeIcon size={11} className={BUTTON_ICON_CLASS} />;
		case "open-pr":
			return <ArrowUpRightIcon size={11} className={BUTTON_ICON_CLASS} />;
		case "closed":
			return (
				<GitPullRequestClosedIcon size={11} className={BUTTON_ICON_CLASS} />
			);
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
	const buttonColorVars = getButtonColorVars(mode, currentState);
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

	const group = (
		<ButtonGroup
			aria-label={mainText}
			className={cn(
				"h-5 inline-flex items-stretch rounded-[3px] border border-[var(--button-border)] bg-[var(--button-bg)] p-0 shadow-none",
				className,
			)}
			style={buttonColorVars}
		>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={
					isGhostMode || isBusy || currentState === "disabled" || disabled
				}
				onClick={() => runAction(onCommit)}
				className={cn(
					BUTTON_STYLE,
					"min-w-0 cursor-pointer gap-1 rounded-[3px] border-0 bg-transparent px-1.5 text-[var(--button-fg)] shadow-none hover:bg-[var(--button-bg-hover)] hover:text-[var(--button-fg-hover)]",
					(isBusy || isGhostMode) && "pointer-events-none",
				)}
			>
				{mainIcon}
				<span>{mainText}</span>
			</Button>
			{hasMenuItems ? (
				<>
					<ButtonGroupSeparator
						className="w-px self-stretch bg-[var(--button-divider)]"
						orientation="vertical"
					/>
					<DropdownMenuTrigger
						aria-label={optionsAriaLabel}
						disabled={
							isBusy || currentState === "disabled" || disabled || !hasMenuItems
						}
						className={cn(
							BUTTON_STYLE,
							"flex min-w-5 cursor-pointer items-center justify-center self-stretch rounded-[3px] border-0 bg-transparent px-0 leading-none text-[var(--button-fg)] shadow-none hover:bg-[var(--button-bg-hover)] hover:text-[var(--button-fg-hover)]",
							isBusy && "pointer-events-none",
						)}
					>
						<ChevronDown
							className="relative -top-px size-2.5 align-middle"
							strokeWidth={2.2}
						/>
					</DropdownMenuTrigger>
				</>
			) : null}
		</ButtonGroup>
	);

	if (!hasMenuItems) {
		return group;
	}

	return (
		<DropdownMenu>
			{group}
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
