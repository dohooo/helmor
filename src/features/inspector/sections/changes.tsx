import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	getMaterialFileIcon,
	getMaterialFolderIcon,
} from "file-extension-icon-js";
import {
	ChevronRightIcon,
	CloudIcon,
	CopyIcon,
	FolderOpenIcon,
	LaptopIcon,
	LinkIcon,
	ListIcon,
	ListTreeIcon,
	LoaderCircleIcon,
	MinusIcon,
	PlusIcon,
	Undo2Icon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NumberTicker } from "@/components/ui/number-ticker";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import {
	type ChangeRequestInfo,
	type ForgeDetection,
	revealPathInFinder,
} from "@/lib/api";
import {
	type ActiveEditorTarget,
	type DiffOpenOptions,
	INDEX_REF,
	type InspectorFileItem,
	isActiveEditorTarget,
} from "@/lib/editor-session";
import {
	helmorQueryKeys,
	workspaceForgeActionStatusQueryOptions,
	workspaceForgeQueryOptions,
} from "@/lib/query-client";
import { buildRemoteFileUrl } from "@/lib/remote-file-url";
import { cn } from "@/lib/utils";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import {
	INSPECTOR_SECTION_HEADER_HEIGHT,
	TABS_ANIMATION_MS,
	TABS_EASING_CURVE,
} from "../layout";
import { useChangesState } from "./changes/use-changes-state";
import { useGitMutations } from "./changes/use-git-mutations";
import { GitSectionHeader } from "./git-section-header";

const STATUS_COLORS: Record<InspectorFileItem["status"], string> = {
	M: "text-yellow-500",
	A: "text-green-500",
	D: "text-red-500",
};

/** A change item already projected into a single area's line counts.
 * `insertions`/`deletions` are derived from the corresponding area
 * (staged / unstaged / committed) — never used elsewhere. */
type ChangeRow = InspectorFileItem & {
	insertions: number;
	deletions: number;
};

type ChangesSectionProps = {
	workspaceId: string | null;
	workspaceRootPath: string | null;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
	workspaceTargetBranch: string | null;
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditor?: ActiveEditorTarget | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	commitButtonMode?: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	changeRequest: ChangeRequestInfo | null;
	/** Cold-fetch indicator owned by App; drives the git-header shimmer. */
	forgeIsRefreshing?: boolean;
	/** Height of the changes body (excluding the section header). */
	bodyHeight: number;
	/** Enables the height transition only for explicit panel toggles. */
	animatePanelToggle?: boolean;
	/** Suppresses the height transition while the user is dragging a divider. */
	isResizing?: boolean;
};

export function ChangesSection({
	workspaceId,
	workspaceRootPath,
	workspaceBranch,
	workspaceRemoteUrl,
	workspaceTargetBranch,
	changes,
	editorMode,
	activeEditor,
	onOpenEditorFile,
	flashingPaths,
	onCommitAction,
	commitButtonMode = "create-pr",
	commitButtonState,
	changeRequest,
	forgeIsRefreshing = false,
	bodyHeight,
	animatePanelToggle = false,
	isResizing,
}: ChangesSectionProps) {
	const shouldReduceMotion = useReducedMotion();
	const panelTransition = {
		duration:
			animatePanelToggle && !isResizing && !shouldReduceMotion
				? TABS_ANIMATION_MS / 1000
				: 0,
		ease: TABS_EASING_CURVE,
	};
	const queryClient = useQueryClient();
	const {
		changesOpen,
		stagedOpen,
		branchDiffOpen,
		changesTreeView,
		branchDiffTreeView,
		toggleChangesOpen,
		toggleStagedOpen,
		toggleBranchDiffOpen,
		toggleChangesTreeView,
		toggleBranchDiffTreeView,
	} = useChangesState();
	const forgeQuery = useQuery({
		...workspaceForgeQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const forgeStatusQuery = useQuery({
		...workspaceForgeActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const cachedForgeDetection = workspaceId
		? queryClient.getQueryData<ForgeDetection>(
				helmorQueryKeys.workspaceForge(workspaceId),
			)
		: null;
	const forgeDetection = forgeQuery.data ?? cachedForgeDetection ?? null;
	const changeRequestName = forgeDetection?.labels.changeRequestName ?? "PR";

	// Only show loading when the user switches target branch within the
	// same workspace — not on workspace/repo navigation or routine polling.
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
		// Clear once fresh data arrives (array identity changes).
		if (changes !== switchChangesRef.current) {
			setBranchSwitching(false);
			return;
		}
		// Safety timeout so loading never gets stuck.
		const id = window.setTimeout(() => setBranchSwitching(false), 5000);
		return () => window.clearTimeout(id);
	}, [branchSwitching, changes]);

	// Each area has its own insertions/deletions. Project the area's stats
	// onto a flat `insertions`/`deletions` pair so downstream components
	// (LineStats etc.) read the correct numbers without knowing which group
	// they're in.
	const stagedChanges = useMemo<ChangeRow[]>(
		() =>
			changes
				.filter((change) => change.stagedStatus != null)
				.map((change) => ({
					...change,
					status: change.stagedStatus ?? change.status,
					insertions: change.stagedInsertions,
					deletions: change.stagedDeletions,
				})),
		[changes],
	);
	const unstagedChanges = useMemo<ChangeRow[]>(
		() =>
			changes
				.filter((change) => change.unstagedStatus != null)
				.map((change) => ({
					...change,
					status: change.unstagedStatus ?? change.status,
					insertions: change.unstagedInsertions,
					deletions: change.unstagedDeletions,
				})),
		[changes],
	);
	const committedChanges = useMemo<ChangeRow[]>(
		() =>
			changes
				.filter((change) => change.committedStatus != null)
				.map((change) => ({
					...change,
					status: change.committedStatus ?? change.status,
					insertions: change.committedInsertions,
					deletions: change.committedDeletions,
				})),
		[changes],
	);
	const hasUncommittedChanges =
		stagedChanges.length > 0 || unstagedChanges.length > 0;
	const hasChanges = hasUncommittedChanges || committedChanges.length > 0;

	const pushToast = useWorkspaceToast();
	const {
		isContinuingWorkspace,
		stageFile,
		unstageFile,
		stageAll,
		unstageAll,
		discardFile,
		continueWorkspace: handleContinueWorkspace,
	} = useGitMutations({
		workspaceId,
		workspaceRootPath,
		stagedChanges,
		unstagedChanges,
		queryClient,
		pushToast,
	});

	const handleCommitButtonClick = useCallback(async () => {
		if (!onCommitAction) {
			return;
		}
		await onCommitAction(commitButtonMode);
	}, [commitButtonMode, onCommitAction]);

	// Header shimmer is owned by App: it knows when the change-request and
	// forge-action-status queries are on their *first* cold fetch (vs. just a
	// background refresh or a placeholder render).
	const isForgeRefreshing = workspaceId !== null && forgeIsRefreshing;

	return (
		<motion.section
			aria-label="Inspector section Git"
			className="flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar"
			initial={false}
			animate={{ height: INSPECTOR_SECTION_HEADER_HEIGHT + bodyHeight }}
			transition={panelTransition}
			style={{ willChange: isResizing ? undefined : "height" }}
		>
			<GitSectionHeader
				commitButtonMode={commitButtonMode}
				commitButtonState={commitButtonState}
				changeRequest={changeRequest}
				changeRequestName={changeRequestName}
				forgeRemoteState={forgeStatusQuery.data?.remoteState ?? null}
				forgeDetection={forgeDetection}
				workspaceId={workspaceId}
				hasChanges={hasChanges}
				isRefreshing={isForgeRefreshing}
				isContinuingWorkspace={isContinuingWorkspace}
				onChangeRequestClick={
					changeRequest ? () => void openUrl(changeRequest.url) : undefined
				}
				onCommit={handleCommitButtonClick}
				onContinueWorkspace={handleContinueWorkspace}
			/>

			<ScrollArea
				aria-label="Changes panel body"
				className="min-h-0 flex-1 bg-muted/20 font-mono text-[11.5px]"
			>
				{hasUncommittedChanges && (
					<>
						{stagedChanges.length > 0 && (
							<ChangesGroup
								label="Staged Changes"
								count={stagedChanges.length}
								open={stagedOpen}
								onToggle={() => toggleStagedOpen()}
								changes={stagedChanges}
								treeView={changesTreeView}
								onToggleTreeView={() => toggleChangesTreeView()}
								action="unstage"
								onStageAction={unstageFile}
								onBatchAction={unstageAll}
								editorMode={editorMode}
								activeEditor={activeEditor}
								onOpenEditorFile={onOpenEditorFile}
								flashingPaths={flashingPaths}
								workspaceBranch={workspaceBranch}
								workspaceRemoteUrl={workspaceRemoteUrl}
								originalRef="HEAD"
								modifiedRef={INDEX_REF}
							/>
						)}
						{unstagedChanges.length > 0 && (
							<ChangesGroup
								label="Changes"
								icon={
									<LaptopIcon
										className="size-3 shrink-0 text-muted-foreground"
										strokeWidth={2}
									/>
								}
								count={unstagedChanges.length}
								open={changesOpen}
								onToggle={() => toggleChangesOpen()}
								changes={unstagedChanges}
								treeView={changesTreeView}
								onToggleTreeView={() => toggleChangesTreeView()}
								action="stage"
								onStageAction={stageFile}
								onBatchAction={stageAll}
								onDiscard={discardFile}
								editorMode={editorMode}
								activeEditor={activeEditor}
								onOpenEditorFile={onOpenEditorFile}
								flashingPaths={flashingPaths}
								workspaceBranch={workspaceBranch}
								workspaceRemoteUrl={workspaceRemoteUrl}
								originalRef={INDEX_REF}
							/>
						)}
					</>
				)}

				{(committedChanges.length > 0 || branchSwitching) && (
					<BranchDiffSection
						targetBranch={workspaceTargetBranch}
						count={committedChanges.length}
						loading={branchSwitching}
						open={branchDiffOpen}
						onToggle={() => toggleBranchDiffOpen()}
						changes={committedChanges}
						treeView={branchDiffTreeView}
						onToggleTreeView={() => toggleBranchDiffTreeView()}
						editorMode={editorMode}
						activeEditor={activeEditor}
						onOpenEditorFile={onOpenEditorFile}
						flashingPaths={flashingPaths}
						workspaceBranch={workspaceBranch}
						workspaceRemoteUrl={workspaceRemoteUrl}
					/>
				)}

				{!hasChanges && (
					<div className="px-3 py-3 text-[11px] leading-5 text-muted-foreground">
						No changes on this branch yet.
					</div>
				)}
			</ScrollArea>
		</motion.section>
	);
}

type StageActionKind = "stage" | "unstage";

function ChangesGroup({
	label,
	icon,
	count,
	open,
	onToggle,
	changes,
	treeView,
	onToggleTreeView,
	action,
	onStageAction,
	onBatchAction,
	onDiscard,
	editorMode,
	activeEditor,
	onOpenEditorFile,
	flashingPaths,
	workspaceBranch,
	workspaceRemoteUrl,
	originalRef,
	modifiedRef,
}: {
	label: string;
	icon?: React.ReactNode;
	count: number;
	open: boolean;
	onToggle: () => void;
	changes: ChangeRow[];
	treeView: boolean;
	onToggleTreeView: () => void;
	action: StageActionKind;
	onStageAction: (path: string) => void;
	onBatchAction?: () => void;
	onDiscard?: (path: string) => void;
	editorMode: boolean;
	activeEditor?: ActiveEditorTarget | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
	/** Git ref for the original (left) side. Staged → "HEAD"; Unstaged → INDEX_REF. */
	originalRef?: string;
	/** Git ref for the modified (right) side. Staged → INDEX_REF; Unstaged → undefined
	 * (so the editor reads the working tree from disk). */
	modifiedRef?: string;
}) {
	const handleOpenFile = useCallback(
		(path: string, options?: DiffOpenOptions) => {
			onOpenEditorFile(path, {
				fileStatus: options?.fileStatus ?? "M",
				originalRef,
				modifiedRef,
			});
		},
		[onOpenEditorFile, originalRef, modifiedRef],
	);
	// Same file can appear in Staged AND Unstaged. The selection highlight
	// belongs to whichever area's bases match the open editor — comparing
	// path alone lights up both rows simultaneously.
	const activeEditorPath = isActiveEditorTarget(
		activeEditor,
		originalRef,
		modifiedRef,
	)
		? activeEditor.path
		: null;
	return (
		<div>
			<div className="group/header flex w-full items-center gap-1 py-1 pl-1 pr-2 text-[11.5px] font-semibold tracking-[-0.01em] text-muted-foreground">
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={onToggle}
					aria-expanded={open}
					className="h-auto min-w-0 flex-1 justify-start gap-1 rounded-none px-0 text-left hover:bg-transparent hover:text-foreground dark:hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-foreground"
				>
					<ChevronRightIcon
						data-icon="inline-start"
						className={cn(
							"size-3 shrink-0 transition-transform",
							open && "rotate-90",
						)}
						strokeWidth={2}
					/>
					{icon}
					<span className="truncate">{label}</span>
				</Button>
				<ViewToggleButton treeView={treeView} onToggle={onToggleTreeView} />
				{onBatchAction && (
					<RowIconButton
						aria-label={
							action === "stage" ? "Stage all changes" : "Unstage all changes"
						}
						onClick={onBatchAction}
						className="text-transparent hover:bg-transparent group-hover/header:text-muted-foreground group-hover/header:hover:text-foreground"
					>
						{action === "stage" ? (
							<PlusIcon className="size-3.5" strokeWidth={2} />
						) : (
							<MinusIcon className="size-3.5" strokeWidth={2} />
						)}
					</RowIconButton>
				)}
				<Badge
					variant="secondary"
					className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] font-semibold"
				>
					{count}
				</Badge>
			</div>
			{open && (
				<div className="pl-3">
					{treeView ? (
						<ChangesTreeView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={handleOpenFile}
							flashingPaths={flashingPaths}
							action={action}
							onStageAction={onStageAction}
							onDiscard={onDiscard}
							workspaceBranch={workspaceBranch}
							workspaceRemoteUrl={workspaceRemoteUrl}
						/>
					) : (
						<ChangesFlatView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={handleOpenFile}
							flashingPaths={flashingPaths}
							action={action}
							onStageAction={onStageAction}
							onDiscard={onDiscard}
							workspaceBranch={workspaceBranch}
							workspaceRemoteUrl={workspaceRemoteUrl}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function BranchDiffSection({
	targetBranch,
	count,
	loading,
	open,
	onToggle,
	changes,
	treeView,
	onToggleTreeView,
	editorMode,
	activeEditor,
	onOpenEditorFile,
	flashingPaths,
	workspaceBranch,
	workspaceRemoteUrl,
}: {
	targetBranch: string | null;
	count: number;
	loading: boolean;
	open: boolean;
	onToggle: () => void;
	changes: ChangeRow[];
	treeView: boolean;
	onToggleTreeView: () => void;
	editorMode: boolean;
	activeEditor?: ActiveEditorTarget | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
}) {
	const remoteOriginalRef = targetBranch ?? undefined;
	const remoteModifiedRef = "HEAD";
	const handleOpenFile = useCallback(
		(path: string, options?: DiffOpenOptions) => {
			onOpenEditorFile(path, {
				fileStatus: options?.fileStatus ?? "M",
				originalRef: remoteOriginalRef,
				modifiedRef: remoteModifiedRef,
			});
		},
		[onOpenEditorFile, remoteOriginalRef, remoteModifiedRef],
	);
	const activeEditorPath = isActiveEditorTarget(
		activeEditor,
		remoteOriginalRef,
		remoteModifiedRef,
	)
		? activeEditor.path
		: null;

	return (
		<div>
			<div className="group/header flex w-full items-center gap-1 py-1 pl-1 pr-2 text-[11.5px] font-semibold tracking-[-0.01em] text-muted-foreground">
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={onToggle}
					aria-expanded={open}
					className="h-auto min-w-0 flex-1 justify-start gap-1 rounded-none px-0 text-left hover:bg-transparent hover:text-foreground dark:hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-foreground"
				>
					<ChevronRightIcon
						data-icon="inline-start"
						className={cn(
							"size-3 shrink-0 transition-transform",
							open && "rotate-90",
						)}
						strokeWidth={2}
					/>
					<CloudIcon
						className="size-3 shrink-0 text-muted-foreground"
						strokeWidth={2}
					/>
					<span className="truncate">Remote</span>
				</Button>
				<ViewToggleButton treeView={treeView} onToggle={onToggleTreeView} />
				<Badge
					variant="secondary"
					className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none"
				>
					{loading ? (
						<LoaderCircleIcon className="size-2.5 animate-spin" />
					) : (
						count
					)}
				</Badge>
			</div>
			{open && (
				<div
					className={cn(
						"pl-3 transition-opacity duration-150",
						loading && "pointer-events-none opacity-40",
					)}
				>
					{loading && changes.length === 0 ? (
						<div className="px-2 py-2 text-[10.5px] text-muted-foreground">
							Switching target branch…
						</div>
					) : treeView ? (
						<ChangesTreeView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={handleOpenFile}
							flashingPaths={flashingPaths}
							workspaceBranch={workspaceBranch}
							workspaceRemoteUrl={workspaceRemoteUrl}
						/>
					) : (
						<ChangesFlatView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={handleOpenFile}
							flashingPaths={flashingPaths}
							workspaceBranch={workspaceBranch}
							workspaceRemoteUrl={workspaceRemoteUrl}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function buildTree(changes: ChangeRow[]) {
	type TreeNode = {
		name: string;
		path: string;
		children: Map<string, TreeNode>;
		file?: ChangeRow;
	};

	const root: TreeNode = { name: "", path: "", children: new Map() };

	for (const change of changes) {
		const parts = change.path.split("/");
		let current = root;
		for (let index = 0; index < parts.length - 1; index += 1) {
			const part = parts[index];
			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					path: parts.slice(0, index + 1).join("/"),
					children: new Map(),
				});
			}
			current = current.children.get(part)!;
		}
		current.children.set(change.name, {
			name: change.name,
			path: change.path,
			children: new Map(),
			file: change,
		});
	}

	return root;
}

function ChangesTreeView({
	changes,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
	action,
	onStageAction,
	onDiscard,
	workspaceBranch,
	workspaceRemoteUrl,
}: {
	changes: ChangeRow[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
}) {
	const tree = buildTree(changes);
	const [expanded, setExpanded] = useState<Set<string>>(
		() => new Set(collectFolderPaths(tree)),
	);

	const toggle = (path: string) => {
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	};

	return (
		<div className="py-0.5">
			<TreeNodeList
				nodes={tree.children}
				expanded={expanded}
				onToggle={toggle}
				depth={0}
				editorMode={editorMode}
				activeEditorPath={activeEditorPath}
				onOpenEditorFile={onOpenEditorFile}
				flashingPaths={flashingPaths}
				action={action}
				onStageAction={onStageAction}
				onDiscard={onDiscard}
				workspaceBranch={workspaceBranch}
				workspaceRemoteUrl={workspaceRemoteUrl}
			/>
		</div>
	);
}

function collectFolderPaths(node: ReturnType<typeof buildTree>): string[] {
	const paths: string[] = [];
	for (const child of node.children.values()) {
		if (child.children.size > 0 && !child.file) {
			paths.push(child.path);
			paths.push(...collectFolderPaths(child));
		}
	}
	return paths;
}

function TreeNodeList({
	nodes,
	expanded,
	onToggle,
	depth,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
	action,
	onStageAction,
	onDiscard,
	workspaceBranch,
	workspaceRemoteUrl,
}: {
	nodes: Map<string, ReturnType<typeof buildTree>>;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	depth: number;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
}) {
	const sorted = [...nodes.values()].sort((left, right) => {
		const leftIsFolder = left.children.size > 0 && !left.file;
		const rightIsFolder = right.children.size > 0 && !right.file;
		if (leftIsFolder !== rightIsFolder) {
			return leftIsFolder ? -1 : 1;
		}
		return left.name.localeCompare(right.name);
	});

	return (
		<>
			{sorted.map((node) => {
				const isFolder = node.children.size > 0 && !node.file;

				if (isFolder) {
					const isOpen = expanded.has(node.path);
					return (
						<div key={node.path}>
							<div
								className="flex cursor-interactive items-center gap-1 py-[1.5px] pr-2 text-muted-foreground transition-colors hover:bg-accent/60"
								style={{ paddingLeft: `${depth * 12 + 8}px` }}
								onClick={() => onToggle(node.path)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										onToggle(node.path);
									}
								}}
								tabIndex={0}
								role="treeitem"
								aria-expanded={isOpen}
							>
								<ChevronRightIcon
									className={cn(
										"size-3 shrink-0 transition-transform",
										isOpen && "rotate-90",
									)}
									strokeWidth={1.8}
								/>
								<img
									src={getMaterialFolderIcon(node.name, isOpen || undefined)}
									alt=""
									className="size-4 shrink-0"
								/>
								<span className="truncate">{node.name}</span>
							</div>
							{isOpen && (
								<TreeNodeList
									nodes={node.children}
									expanded={expanded}
									onToggle={onToggle}
									depth={depth + 1}
									editorMode={editorMode}
									activeEditorPath={activeEditorPath}
									onOpenEditorFile={onOpenEditorFile}
									flashingPaths={flashingPaths}
									action={action}
									onStageAction={onStageAction}
									onDiscard={onDiscard}
									workspaceBranch={workspaceBranch}
									workspaceRemoteUrl={workspaceRemoteUrl}
								/>
							)}
						</div>
					);
				}

				const file = node.file;
				const selected = file?.absolutePath === activeEditorPath;
				const isFlashing = !!file && flashingPaths.has(file.path);

				const row = (
					<div
						className={cn(
							"group/row flex cursor-interactive items-center gap-1 py-[1.5px] pr-2 text-muted-foreground transition-colors hover:bg-accent/60",
							selected &&
								(editorMode
									? "bg-accent text-foreground"
									: "bg-muted/60 text-foreground"),
						)}
						style={{ paddingLeft: `${depth * 12 + 22}px` }}
						role="treeitem"
						tabIndex={0}
						onClick={() =>
							file &&
							onOpenEditorFile(file.absolutePath, {
								fileStatus: file.status,
							})
						}
						onKeyDown={(event) => {
							if ((event.key === "Enter" || event.key === " ") && file) {
								event.preventDefault();
								onOpenEditorFile(file.absolutePath, {
									fileStatus: file.status,
								});
							}
						}}
					>
						<img
							src={getMaterialFileIcon(node.name)}
							alt=""
							className="size-4 shrink-0"
						/>
						<ShinyFlash active={isFlashing}>{node.name}</ShinyFlash>
						{file && (
							<StageActionSlot
								file={file}
								action={action}
								onStageAction={onStageAction}
								onDiscard={onDiscard}
							/>
						)}
					</div>
				);

				return (
					<div key={node.path}>
						{file ? (
							<FileRowContextMenu
								file={file}
								workspaceBranch={workspaceBranch}
								workspaceRemoteUrl={workspaceRemoteUrl}
							>
								{row}
							</FileRowContextMenu>
						) : (
							row
						)}
					</div>
				);
			})}
		</>
	);
}

function ChangesFlatView({
	changes,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
	action,
	onStageAction,
	onDiscard,
	workspaceBranch,
	workspaceRemoteUrl,
}: {
	changes: ChangeRow[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
}) {
	const hasStage = !!action && !!onStageAction;
	const hasDiscard = !!onDiscard;
	const hasAction = hasStage || hasDiscard;

	return (
		<div className="py-0.5">
			{changes.map((change) => (
				<FileRowContextMenu
					key={change.path}
					file={change}
					workspaceBranch={workspaceBranch}
					workspaceRemoteUrl={workspaceRemoteUrl}
				>
					<div
						className={cn(
							"group/row flex cursor-interactive items-center gap-1.5 py-[1.5px] pl-2 pr-2 text-muted-foreground transition-colors hover:bg-accent/60",
							change.absolutePath === activeEditorPath &&
								(editorMode
									? "bg-accent text-foreground"
									: "bg-muted/60 text-foreground"),
						)}
						role="button"
						tabIndex={0}
						onClick={() =>
							onOpenEditorFile(change.absolutePath, {
								fileStatus: change.status,
							})
						}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onOpenEditorFile(change.absolutePath, {
									fileStatus: change.status,
								});
							}
						}}
					>
						<img
							src={getMaterialFileIcon(change.name)}
							alt=""
							className="size-4 shrink-0"
						/>
						<span className="min-w-0 max-w-[60%] truncate">
							<ShinyFlash active={flashingPaths.has(change.path)}>
								{change.name}
							</ShinyFlash>
						</span>
						<span
							className={cn(
								"min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground",
								hasAction && "group-hover/row:hidden",
							)}
						>
							{change.path.includes("/")
								? change.path.slice(0, change.path.lastIndexOf("/"))
								: ""}
						</span>
						<span
							className={cn(
								"flex shrink-0 items-center gap-1 tabular-nums",
								hasAction && "group-hover/row:hidden",
							)}
						>
							<LineStats
								insertions={change.insertions}
								deletions={change.deletions}
							/>
							<span
								className={cn(
									"inline-flex h-4 w-4 items-center justify-center text-[10px] font-semibold",
									STATUS_COLORS[change.status],
								)}
							>
								{change.status}
							</span>
						</span>
						{hasAction && (
							<RowHoverActions
								path={change.path}
								action={action}
								onStageAction={onStageAction}
								onDiscard={onDiscard}
							/>
						)}
					</div>
				</FileRowContextMenu>
			))}
		</div>
	);
}

function StageActionSlot({
	file,
	action,
	onStageAction,
	onDiscard,
}: {
	file: ChangeRow;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
}) {
	const hasStage = !!action && !!onStageAction;
	const hasDiscard = !!onDiscard;
	const hasAction = hasStage || hasDiscard;

	return (
		<>
			<span
				className={cn(
					"ml-auto flex shrink-0 items-center gap-1.5",
					hasAction && "group-hover/row:hidden",
				)}
			>
				<LineStats insertions={file.insertions} deletions={file.deletions} />
				<span
					className={cn(
						"inline-flex h-4 w-4 items-center justify-center text-[10px] font-semibold",
						STATUS_COLORS[file.status],
					)}
				>
					{file.status}
				</span>
			</span>
			{hasAction && (
				<RowHoverActions
					path={file.path}
					action={action}
					onStageAction={onStageAction}
					onDiscard={onDiscard}
				/>
			)}
		</>
	);
}

function RowHoverActions({
	path,
	action,
	onStageAction,
	onDiscard,
}: {
	path: string;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
}) {
	return (
		<span className="ml-auto hidden items-center gap-0.5 group-hover/row:inline-flex">
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

function RowIconButton({
	onClick,
	disabled = false,
	children,
	className,
	"aria-label": ariaLabel,
}: {
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
	className?: string;
	"aria-label": string;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
			onKeyDown={(event) => event.stopPropagation()}
			className={cn(
				"size-4 rounded-sm transition-colors disabled:pointer-events-none disabled:opacity-60",
				className,
			)}
		>
			{children}
		</Button>
	);
}

function ViewToggleButton({
	treeView,
	onToggle,
}: {
	treeView: boolean;
	onToggle: () => void;
}) {
	return (
		<RowIconButton
			aria-label={treeView ? "Switch to list view" : "Switch to tree view"}
			onClick={onToggle}
			className="text-transparent hover:bg-transparent group-hover/header:text-muted-foreground group-hover/header:hover:text-foreground"
		>
			{treeView ? (
				<ListIcon className="size-3.5" strokeWidth={1.8} />
			) : (
				<ListTreeIcon className="size-3.5" strokeWidth={1.8} />
			)}
		</RowIconButton>
	);
}

async function copyToClipboard(value: string, label: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast.success(`${label} copied`, { description: value, duration: 2000 });
	} catch {
		toast.error(`Failed to copy ${label.toLowerCase()}`);
	}
}

function FileRowContextMenu({
	file,
	workspaceBranch,
	workspaceRemoteUrl,
	children,
}: {
	file: ChangeRow;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
	children: React.ReactNode;
}) {
	const remoteFileUrl = useMemo(
		() => buildRemoteFileUrl(workspaceRemoteUrl, workspaceBranch, file.path),
		[file.path, workspaceBranch, workspaceRemoteUrl],
	);

	const handleReveal = useCallback(async () => {
		try {
			await revealPathInFinder(file.absolutePath);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to reveal in Finder";
			toast.error(message);
		}
	}, [file.absolutePath]);

	const handleCopyAbsolute = useCallback(
		() => copyToClipboard(file.absolutePath, "Path"),
		[file.absolutePath],
	);
	const handleCopyRelative = useCallback(
		() => copyToClipboard(file.path, "Relative path"),
		[file.path],
	);
	const handleCopyRemoteUrl = useCallback(() => {
		if (!remoteFileUrl) return;
		void copyToClipboard(remoteFileUrl, "Remote file URL");
	}, [remoteFileUrl]);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent className="min-w-52">
				<ContextMenuItem onClick={() => void handleReveal()}>
					<FolderOpenIcon />
					<span>Reveal in Finder</span>
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={handleCopyAbsolute}>
					<CopyIcon />
					<span>Copy Path</span>
				</ContextMenuItem>
				<ContextMenuItem onClick={handleCopyRelative}>
					<CopyIcon />
					<span>Copy Relative Path</span>
				</ContextMenuItem>
				<ContextMenuItem
					onClick={handleCopyRemoteUrl}
					disabled={!remoteFileUrl}
				>
					<LinkIcon />
					<span>Copy Remote File URL</span>
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function LineStats({
	insertions,
	deletions,
}: {
	insertions: number;
	deletions: number;
}) {
	if (insertions === 0 && deletions === 0) {
		return null;
	}

	return (
		<span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
			{insertions > 0 && (
				<span className="text-chart-2">
					+<NumberTicker value={insertions} className="text-chart-2" />
				</span>
			)}
			{deletions > 0 && (
				<span className="text-destructive">
					−<NumberTicker value={deletions} className="text-destructive" />
				</span>
			)}
		</span>
	);
}

function ShinyFlash({
	active,
	children,
}: {
	active: boolean;
	children: React.ReactNode;
}) {
	const [shimmer, setShimmer] = useState(false);
	const counterRef = useRef(0);

	useEffect(() => {
		if (!active) {
			return;
		}
		counterRef.current += 1;
		setShimmer(true);
		const timeoutId = window.setTimeout(() => setShimmer(false), 3000);
		return () => window.clearTimeout(timeoutId);
	}, [active]);

	if (!shimmer) {
		return <span className="truncate">{children}</span>;
	}

	return (
		<AnimatedShinyText
			key={counterRef.current}
			shimmerWidth={60}
			className="!mx-0 !max-w-none truncate !text-neutral-500/80 ![animation-duration:1s] ![animation-iteration-count:3] ![animation-name:shiny-text-continuous] ![animation-timing-function:ease-in-out] dark:!text-neutral-500/80 dark:via-white via-black"
		>
			{children}
		</AnimatedShinyText>
	);
}
