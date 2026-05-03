import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	getMaterialFileIcon,
	getMaterialFolderIcon,
} from "file-extension-icon-js";
import {
	ChevronRightIcon,
	CloudIcon,
	LaptopIcon,
	ListIcon,
	ListTreeIcon,
	LoaderCircleIcon,
	MinusIcon,
	PlusIcon,
	Undo2Icon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumberTicker } from "@/components/ui/number-ticker";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import {
	type ChangeRequestInfo,
	continueWorkspaceFromTargetBranch,
	discardWorkspaceFile,
	type ForgeDetection,
	stageWorkspaceFile,
	unstageWorkspaceFile,
} from "@/lib/api";
import type { DiffOpenOptions, InspectorFileItem } from "@/lib/editor-session";
import { extractError, isRecoverableByPurge } from "@/lib/errors";
import {
	helmorQueryKeys,
	workspaceForgeActionStatusQueryOptions,
	workspaceForgeQueryOptions,
} from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { showWorkspaceBrokenToast } from "@/lib/workspace-broken-toast";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import {
	INSPECTOR_SECTION_HEADER_HEIGHT,
	TABS_ANIMATION_MS,
	TABS_EASING_CURVE,
} from "../layout";
import { GitSectionHeader } from "./git-section-header";

const STATUS_COLORS: Record<InspectorFileItem["status"], string> = {
	M: "text-yellow-500",
	A: "text-green-500",
	D: "text-red-500",
};

type ChangesSectionProps = {
	workspaceId: string | null;
	workspaceRootPath: string | null;
	workspaceTargetBranch: string | null;
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
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
	/** Suppresses the height transition while the user is dragging a divider. */
	isResizing?: boolean;
};

export function ChangesSection({
	workspaceId,
	workspaceRootPath,
	workspaceTargetBranch,
	changes,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
	onCommitAction,
	commitButtonMode = "create-pr",
	commitButtonState,
	changeRequest,
	forgeIsRefreshing = false,
	bodyHeight,
	isResizing,
}: ChangesSectionProps) {
	const shouldReduceMotion = useReducedMotion();
	const panelTransition = {
		duration: isResizing || shouldReduceMotion ? 0 : TABS_ANIMATION_MS / 1000,
		ease: TABS_EASING_CURVE,
	};
	const queryClient = useQueryClient();
	const [changesTreeView, setChangesTreeView] = useState(true);
	const [branchDiffTreeView, setBranchDiffTreeView] = useState(true);
	const [changesOpen, setChangesOpen] = useState(true);
	const [stagedOpen, setStagedOpen] = useState(true);
	const [branchDiffOpen, setBranchDiffOpen] = useState(true);
	const [isContinuingWorkspace, setIsContinuingWorkspace] = useState(false);
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

	const stagedChanges = useMemo(
		() =>
			changes
				.filter((change) => change.stagedStatus != null)
				.map((change) => ({
					...change,
					status: change.stagedStatus ?? change.status,
				})),
		[changes],
	);
	const unstagedChanges = useMemo(
		() =>
			changes
				.filter((change) => change.unstagedStatus != null)
				.map((change) => ({
					...change,
					status: change.unstagedStatus ?? change.status,
				})),
		[changes],
	);
	const committedChanges = useMemo(
		() =>
			changes
				.filter((change) => change.committedStatus != null)
				.map((change) => ({
					...change,
					status: change.committedStatus ?? change.status,
				})),
		[changes],
	);
	const hasUncommittedChanges =
		stagedChanges.length > 0 || unstagedChanges.length > 0;
	const hasChanges = hasUncommittedChanges || committedChanges.length > 0;
	const invalidateChanges = useCallback(() => {
		if (!workspaceRootPath) {
			return;
		}
		queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.workspaceChanges(workspaceRootPath),
		});
		if (workspaceId) {
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
			});
		}
	}, [queryClient, workspaceId, workspaceRootPath]);

	const pushToast = useWorkspaceToast();
	// Surface backend mutation failures (which used to be silently
	// swallowed). If the workspace is broken, show a persistent toast
	// with "Permanently Delete" — never auto-deletes. Dismiss preserves
	// the chat history (the startup reconcile has archived the row so
	// the user can still find it).
	const surfaceChangeError = useCallback(
		(action: string, error: unknown) => {
			const { code, message } = extractError(error, `Failed to ${action}.`);
			if (isRecoverableByPurge(code) && workspaceId) {
				showWorkspaceBrokenToast({
					workspaceId,
					pushToast,
					queryClient,
				});
				return;
			}
			pushToast(message, `Unable to ${action}`, "destructive");
		},
		[pushToast, queryClient, workspaceId],
	);

	const stageFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) {
				return;
			}
			try {
				await stageWorkspaceFile(workspaceRootPath, relativePath);
			} catch (error) {
				surfaceChangeError("stage file", error);
			} finally {
				invalidateChanges();
			}
		},
		[invalidateChanges, surfaceChangeError, workspaceRootPath],
	);
	const unstageFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) {
				return;
			}
			try {
				await unstageWorkspaceFile(workspaceRootPath, relativePath);
			} catch (error) {
				surfaceChangeError("unstage file", error);
			} finally {
				invalidateChanges();
			}
		},
		[invalidateChanges, surfaceChangeError, workspaceRootPath],
	);
	const stageAll = useCallback(async () => {
		if (!workspaceRootPath) {
			return;
		}
		const paths = unstagedChanges.map((change) => change.path);
		try {
			for (const path of paths) {
				await stageWorkspaceFile(workspaceRootPath, path);
			}
		} catch (error) {
			surfaceChangeError("stage files", error);
		} finally {
			invalidateChanges();
		}
	}, [
		invalidateChanges,
		surfaceChangeError,
		unstagedChanges,
		workspaceRootPath,
	]);
	const unstageAll = useCallback(async () => {
		if (!workspaceRootPath) {
			return;
		}
		const paths = stagedChanges.map((change) => change.path);
		try {
			for (const path of paths) {
				await unstageWorkspaceFile(workspaceRootPath, path);
			}
		} catch (error) {
			surfaceChangeError("unstage files", error);
		} finally {
			invalidateChanges();
		}
	}, [invalidateChanges, stagedChanges, surfaceChangeError, workspaceRootPath]);

	const discardFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) {
				return;
			}
			try {
				await discardWorkspaceFile(workspaceRootPath, relativePath);
			} catch (error) {
				surfaceChangeError("discard changes", error);
			} finally {
				invalidateChanges();
			}
		},
		[invalidateChanges, surfaceChangeError, workspaceRootPath],
	);

	const handleCommitButtonClick = useCallback(async () => {
		if (!onCommitAction) {
			return;
		}
		await onCommitAction(commitButtonMode);
	}, [commitButtonMode, onCommitAction]);

	const handleContinueWorkspace = useCallback(async () => {
		if (!workspaceId || isContinuingWorkspace) return;
		setIsContinuingWorkspace(true);
		try {
			const result = await continueWorkspaceFromTargetBranch(workspaceId);
			pushToast(`Workspace moved to ${result.branch}.`, "Continued", "default");
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChangeRequest(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
				}),
			]);
			invalidateChanges();
		} catch (error) {
			surfaceChangeError("continue workspace", error);
		} finally {
			setIsContinuingWorkspace(false);
		}
	}, [
		invalidateChanges,
		isContinuingWorkspace,
		pushToast,
		queryClient,
		surfaceChangeError,
		workspaceId,
	]);

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
								onToggle={() => setStagedOpen((current) => !current)}
								changes={stagedChanges}
								treeView={changesTreeView}
								onToggleTreeView={() => setChangesTreeView((v) => !v)}
								action="unstage"
								onStageAction={unstageFile}
								onBatchAction={unstageAll}
								editorMode={editorMode}
								activeEditorPath={activeEditorPath}
								onOpenEditorFile={onOpenEditorFile}
								flashingPaths={flashingPaths}
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
								onToggle={() => setChangesOpen((current) => !current)}
								changes={unstagedChanges}
								treeView={changesTreeView}
								onToggleTreeView={() => setChangesTreeView((v) => !v)}
								action="stage"
								onStageAction={stageFile}
								onBatchAction={stageAll}
								onDiscard={discardFile}
								editorMode={editorMode}
								activeEditorPath={activeEditorPath}
								onOpenEditorFile={onOpenEditorFile}
								flashingPaths={flashingPaths}
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
						onToggle={() => setBranchDiffOpen((current) => !current)}
						changes={committedChanges}
						treeView={branchDiffTreeView}
						onToggleTreeView={() => setBranchDiffTreeView((v) => !v)}
						editorMode={editorMode}
						activeEditorPath={activeEditorPath}
						onOpenEditorFile={onOpenEditorFile}
						flashingPaths={flashingPaths}
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
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
}: {
	label: string;
	icon?: React.ReactNode;
	count: number;
	open: boolean;
	onToggle: () => void;
	changes: InspectorFileItem[];
	treeView: boolean;
	onToggleTreeView: () => void;
	action: StageActionKind;
	onStageAction: (path: string) => void;
	onBatchAction?: () => void;
	onDiscard?: (path: string) => void;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
}) {
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
							onOpenEditorFile={onOpenEditorFile}
							flashingPaths={flashingPaths}
							action={action}
							onStageAction={onStageAction}
							onDiscard={onDiscard}
						/>
					) : (
						<ChangesFlatView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={onOpenEditorFile}
							flashingPaths={flashingPaths}
							action={action}
							onStageAction={onStageAction}
							onDiscard={onDiscard}
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
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
}: {
	targetBranch: string | null;
	count: number;
	loading: boolean;
	open: boolean;
	onToggle: () => void;
	changes: InspectorFileItem[];
	treeView: boolean;
	onToggleTreeView: () => void;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
}) {
	const handleOpenFile = useCallback(
		(path: string, options?: DiffOpenOptions) => {
			onOpenEditorFile(path, {
				fileStatus: options?.fileStatus ?? "M",
				originalRef: targetBranch ?? undefined,
				modifiedRef: "HEAD",
			});
		},
		[onOpenEditorFile, targetBranch],
	);

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
						/>
					) : (
						<ChangesFlatView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={handleOpenFile}
							flashingPaths={flashingPaths}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function buildTree(changes: InspectorFileItem[]) {
	type TreeNode = {
		name: string;
		path: string;
		children: Map<string, TreeNode>;
		file?: InspectorFileItem;
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
}: {
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
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
								className="flex cursor-pointer items-center gap-1 py-[1.5px] pr-2 text-muted-foreground transition-colors hover:bg-accent/60"
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
								/>
							)}
						</div>
					);
				}

				const file = node.file;
				const selected = file?.absolutePath === activeEditorPath;
				const isFlashing = !!file && flashingPaths.has(file.path);

				return (
					<div
						key={node.path}
						className={cn(
							"group/row flex cursor-pointer items-center gap-1 py-[1.5px] pr-2 text-muted-foreground transition-colors hover:bg-accent/60",
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
}: {
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
}) {
	const hasStage = !!action && !!onStageAction;
	const hasDiscard = !!onDiscard;
	const hasAction = hasStage || hasDiscard;

	return (
		<div className="py-0.5">
			{changes.map((change) => (
				<div
					key={change.path}
					className={cn(
						"group/row flex cursor-pointer items-center gap-1.5 py-[1.5px] pl-2 pr-2 text-muted-foreground transition-colors hover:bg-accent/60",
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
	file: InspectorFileItem;
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
