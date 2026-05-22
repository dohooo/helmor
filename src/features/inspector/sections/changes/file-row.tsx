import { ExternalLinkIcon, MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FileRowContextMenu } from "./context-menu";
import {
	getCachedFileIcon,
	LineStats,
	RowIconButton,
	ShinyFlash,
	STATUS_COLORS,
} from "./row-primitives";
import type { ChangeRow, StageActionKind } from "./types";

const GROUP_BODY_INDENT_PX = 12;

export function ChangeFileRow({
	file,
	depth,
	tree,
	editorMode,
	active,
	onOpen,
	onOpenExternalEditor,
	flashing,
	flashKey,
	lineStatsAnimationKey,
	animationsEnabled,
	interactionsEnabled = true,
	action,
	onStageAction,
	onDiscard,
	workspaceBranch,
	workspaceRemoteUrl,
}: {
	file: ChangeRow;
	depth: number;
	tree: boolean;
	editorMode: boolean;
	active: boolean;
	onOpen: (file: ChangeRow) => void;
	onOpenExternalEditor: (path: string) => void;
	flashing: boolean;
	flashKey?: string;
	lineStatsAnimationKey?: string;
	animationsEnabled: boolean;
	interactionsEnabled?: boolean;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
}) {
	const canOpenExternalEditor = file.status !== "D";
	const hasStage = interactionsEnabled && !!action && !!onStageAction;
	const hasDiscard = interactionsEnabled && !!onDiscard;
	const hasHoverAction =
		interactionsEnabled && (canOpenExternalEditor || hasStage || hasDiscard);

	const row = (
		<div
			className={cn(
				"group/row flex h-[21px] items-center py-[1.5px] pr-2 text-muted-foreground",
				interactionsEnabled
					? "cursor-interactive transition-colors hover:bg-accent/60"
					: "cursor-default",
				tree ? "gap-1" : "gap-1.5 pl-5",
				active &&
					(editorMode
						? "bg-accent text-foreground"
						: "bg-muted/60 text-foreground"),
			)}
			style={
				tree
					? { paddingLeft: `${GROUP_BODY_INDENT_PX + depth * 12 + 22}px` }
					: undefined
			}
			role={tree ? "treeitem" : "button"}
			tabIndex={0}
			onClick={() => onOpen(file)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpen(file);
				}
			}}
		>
			<img
				src={getCachedFileIcon(file.name)}
				alt=""
				className="size-4 shrink-0"
			/>
			<FileName
				file={file}
				tree={tree}
				flashing={flashing}
				flashKey={flashKey}
				animationsEnabled={animationsEnabled}
				hasHoverAction={hasHoverAction}
			/>
			<FileStats
				file={file}
				tree={tree}
				hasHoverAction={hasHoverAction}
				animationKey={lineStatsAnimationKey}
				animationsEnabled={animationsEnabled}
			/>
			{hasHoverAction && (
				<RowHoverActions
					path={file.path}
					absolutePath={file.absolutePath}
					canOpenExternalEditor={canOpenExternalEditor}
					action={hasStage ? action : undefined}
					onOpenExternalEditor={onOpenExternalEditor}
					onStageAction={hasStage ? onStageAction : undefined}
					onDiscard={hasDiscard ? onDiscard : undefined}
				/>
			)}
		</div>
	);

	if (!interactionsEnabled) {
		return row;
	}

	return (
		<FileRowContextMenu
			file={file}
			workspaceBranch={workspaceBranch}
			workspaceRemoteUrl={workspaceRemoteUrl}
		>
			{row}
		</FileRowContextMenu>
	);
}

function FileName({
	file,
	tree,
	flashing,
	flashKey,
	animationsEnabled,
	hasHoverAction,
}: {
	file: ChangeRow;
	tree: boolean;
	flashing: boolean;
	flashKey?: string;
	animationsEnabled: boolean;
	hasHoverAction: boolean;
}) {
	if (tree) {
		if (!animationsEnabled) {
			return <span className="min-w-0 truncate text-left">{file.name}</span>;
		}
		return (
			<ShinyFlash active={flashing} flashKey={flashKey}>
				{file.name}
			</ShinyFlash>
		);
	}

	return (
		<>
			<span className="min-w-0 max-w-[60%] truncate">
				{animationsEnabled ? (
					<ShinyFlash active={flashing} flashKey={flashKey}>
						{file.name}
					</ShinyFlash>
				) : (
					<span className="min-w-0 truncate text-left">{file.name}</span>
				)}
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-right text-micro text-muted-foreground",
					hasHoverAction && "group-hover/row:hidden",
				)}
			>
				{file.path.includes("/")
					? file.path.slice(0, file.path.lastIndexOf("/"))
					: ""}
			</span>
		</>
	);
}

function FileStats({
	file,
	tree,
	hasHoverAction,
	animationKey,
	animationsEnabled,
}: {
	file: ChangeRow;
	tree: boolean;
	hasHoverAction: boolean;
	animationKey?: string;
	animationsEnabled: boolean;
}) {
	return (
		<span
			className={cn(
				tree
					? "ml-auto flex shrink-0 items-center gap-1.5"
					: "flex shrink-0 items-center gap-1 tabular-nums",
				hasHoverAction && "group-hover/row:hidden",
			)}
		>
			<LineStats
				insertions={file.insertions}
				deletions={file.deletions}
				animationKey={animationKey}
				animationsEnabled={animationsEnabled}
			/>
			<span
				className={cn(
					"inline-flex h-4 w-4 items-center justify-center text-micro font-semibold",
					STATUS_COLORS[file.status],
				)}
			>
				{file.status}
			</span>
		</span>
	);
}

function RowHoverActions({
	path,
	absolutePath,
	canOpenExternalEditor,
	action,
	onOpenExternalEditor,
	onStageAction,
	onDiscard,
}: {
	path: string;
	absolutePath: string;
	canOpenExternalEditor: boolean;
	action?: StageActionKind;
	onOpenExternalEditor: (path: string) => void;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
}) {
	return (
		<span className="ml-auto hidden items-center gap-0.5 group-hover/row:inline-flex">
			{canOpenExternalEditor && (
				<Tooltip>
					<TooltipTrigger asChild>
						<RowIconButton
							aria-label="Open in editor"
							onClick={() => onOpenExternalEditor(absolutePath)}
							className="text-muted-foreground hover:bg-accent/60 hover:text-foreground"
						>
							<ExternalLinkIcon className="size-3.5" strokeWidth={2} />
						</RowIconButton>
					</TooltipTrigger>
					<TooltipContent side="top">Open in editor</TooltipContent>
				</Tooltip>
			)}
			{onDiscard && (
				<RowIconButton
					aria-label="Discard file changes"
					onClick={() => onDiscard(path)}
					className="text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<Undo2Icon className="size-3.5" strokeWidth={2} />
				</RowIconButton>
			)}
			{action && onStageAction && (
				<RowIconButton
					aria-label={action === "stage" ? "Stage file" : "Unstage file"}
					onClick={() => onStageAction(path)}
					className="text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					{action === "stage" ? (
						<PlusIcon className="size-3.5" strokeWidth={2} />
					) : (
						<MinusIcon className="size-3.5" strokeWidth={2} />
					)}
				</RowIconButton>
			)}
		</span>
	);
}
