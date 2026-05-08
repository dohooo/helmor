import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	CopyIcon,
	FolderOpenIcon,
	LinkIcon,
	MinusIcon,
	PlusIcon,
	Undo2Icon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
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
	continueWorkspaceFromTargetBranch,
	discardWorkspaceFile,
	type ForgeDetection,
	revealPathInFinder,
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
import { buildRemoteFileUrl } from "@/lib/remote-file-url";
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

type StageActionKind = "stage" | "unstage";

type ChangeSide = "staged" | "unstaged" | "remote";

type ChangeEntry = {
	change: InspectorFileItem;
	side: ChangeSide;
	// Line counts projected from this entry's area. `InspectorFileItem`
	// carries per-area counts (staged / unstaged / committed) — a single
	// file may appear in more than one area, so we resolve them at build
	// time instead of letting the row read off `change` directly.
	insertions: number;
	deletions: number;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
};

type ChangesSectionProps = {
	workspaceId: string | null;
	workspaceRootPath: string | null;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
	workspaceTargetBranch: string | null;
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	/**
	 * Sibling-style callback fired in addition to `onOpenEditorFile` whenever
	 * the user clicks a changed-file row. Lets the new tab system listen for
	 * "user wants to open this changed file" without disturbing the legacy
	 * editor flow. `side` describes which row group the file came from.
	 */
	onOpenChangedFile?: (
		file: InspectorFileItem,
		side: "unstaged" | "staged" | "remote",
		options?: DiffOpenOptions,
	) => void;
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
	activeEditorPath,
	onOpenEditorFile,
	onOpenChangedFile,
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

	// ---- Flat list of all changes ----
	// One unified surface: staged → unstaged → committed (remote). The status
	// letter on each row carries its kind (M/A/D); we drop the section-header
	// chrome entirely. Each `ChangeEntry` carries the per-row action set so
	// the renderer doesn't need to re-derive it.
	const entries = useMemo<ChangeEntry[]>(() => {
		const list: ChangeEntry[] = [];
		for (const change of stagedChanges) {
			list.push({
				change,
				side: "staged",
				insertions: change.stagedInsertions,
				deletions: change.stagedDeletions,
				action: "unstage",
				onStageAction: unstageFile,
			});
		}
		for (const change of unstagedChanges) {
			list.push({
				change,
				side: "unstaged",
				insertions: change.unstagedInsertions,
				deletions: change.unstagedDeletions,
				action: "stage",
				onStageAction: stageFile,
				onDiscard: discardFile,
			});
		}
		for (const change of committedChanges) {
			list.push({
				change,
				side: "remote",
				insertions: change.committedInsertions,
				deletions: change.committedDeletions,
			});
		}
		return list;
	}, [
		stagedChanges,
		unstagedChanges,
		committedChanges,
		stageFile,
		unstageFile,
		discardFile,
	]);

	const openEntry = useCallback(
		(entry: ChangeEntry) => {
			const baseOptions: DiffOpenOptions =
				entry.side === "remote"
					? {
							fileStatus: entry.change.status,
							originalRef: workspaceTargetBranch ?? undefined,
							modifiedRef: "HEAD",
						}
					: { fileStatus: entry.change.status };
			if (onOpenChangedFile) {
				onOpenChangedFile(entry.change, entry.side, baseOptions);
				return;
			}
			onOpenEditorFile(entry.change.absolutePath, baseOptions);
		},
		[onOpenChangedFile, onOpenEditorFile, workspaceTargetBranch],
	);

	// ---- Keyboard navigation across the unified list ----
	const rowRefs = useRef(new Map<string, HTMLDivElement>());
	const registerRowRef = useCallback(
		(path: string, el: HTMLDivElement | null) => {
			if (el) {
				rowRefs.current.set(path, el);
			} else {
				rowRefs.current.delete(path);
			}
		},
		[],
	);
	const handleArrowNav = useCallback(
		(currentPath: string, direction: 1 | -1) => {
			const idx = entries.findIndex(
				(entry) => entry.change.path === currentPath,
			);
			if (idx < 0) return;
			const next = idx + direction;
			if (next < 0 || next >= entries.length) return;
			const target = entries[next];
			const el = rowRefs.current.get(target.change.path);
			el?.focus();
			el?.scrollIntoView({ block: "nearest" });
			openEntry(target);
		},
		[entries, openEntry],
	);

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
				changeCount={entries.length}
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
				{branchSwitching && entries.length === 0 ? (
					<div className="px-2 py-2 text-[10.5px] text-muted-foreground">
						Switching target branch…
					</div>
				) : entries.length > 0 ? (
					<ChangesFlatView
						entries={entries}
						editorMode={editorMode}
						activeEditorPath={activeEditorPath}
						onOpenEntry={openEntry}
						flashingPaths={flashingPaths}
						workspaceBranch={workspaceBranch}
						workspaceRemoteUrl={workspaceRemoteUrl}
						registerRowRef={registerRowRef}
						onArrowNav={handleArrowNav}
					/>
				) : (
					<div className="px-3 py-3 text-[11px] leading-5 text-muted-foreground">
						No changes on this branch yet.
					</div>
				)}
			</ScrollArea>
		</motion.section>
	);
}

function ChangesFlatView({
	entries,
	editorMode,
	activeEditorPath,
	onOpenEntry,
	flashingPaths,
	workspaceBranch,
	workspaceRemoteUrl,
	registerRowRef,
	onArrowNav,
}: {
	entries: ChangeEntry[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEntry: (entry: ChangeEntry) => void;
	flashingPaths: Set<string>;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
	registerRowRef?: (path: string, el: HTMLDivElement | null) => void;
	onArrowNav?: (currentPath: string, direction: 1 | -1) => void;
}) {
	return (
		<div className="py-1">
			{entries.map((entry) => {
				const {
					change,
					insertions,
					deletions,
					action,
					onStageAction,
					onDiscard,
				} = entry;
				const lastSlash = change.path.lastIndexOf("/");
				const dir = lastSlash >= 0 ? change.path.slice(0, lastSlash + 1) : "";
				const name =
					lastSlash >= 0 ? change.path.slice(lastSlash + 1) : change.path;
				const selected = change.absolutePath === activeEditorPath;
				const hasAction = !!action || !!onDiscard;
				return (
					<FileRowContextMenu
						key={change.path}
						file={change}
						workspaceBranch={workspaceBranch}
						workspaceRemoteUrl={workspaceRemoteUrl}
					>
						<div
							ref={(el) => registerRowRef?.(change.path, el)}
							className={cn(
								"group/row relative mx-1.5 flex h-[26px] cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-accent/60 focus:outline-none",
								selected &&
									cn(
										"bg-primary/10 text-foreground",
										editorMode && "bg-primary/15",
									),
							)}
							role="button"
							tabIndex={0}
							onClick={() => onOpenEntry(entry)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onOpenEntry(entry);
									return;
								}
								if (event.key === "ArrowDown" || event.key === "ArrowUp") {
									if (!onArrowNav) return;
									event.preventDefault();
									onArrowNav(change.path, event.key === "ArrowDown" ? 1 : -1);
								}
							}}
						>
							<span className="min-w-0 flex-1 truncate text-[11.5px] leading-[18px]">
								<ShinyFlash active={flashingPaths.has(change.path)}>
									<span className="text-muted-foreground/70">{dir}</span>
									<span
										className={cn(
											"text-foreground/85",
											selected && "font-medium text-foreground",
										)}
									>
										{name}
									</span>
								</ShinyFlash>
							</span>
							<span
								className={cn(
									"flex shrink-0 items-center gap-1.5 tabular-nums",
									hasAction && "group-hover/row:hidden",
								)}
							>
								<span
									className={cn(
										"inline-flex h-4 w-3 items-center justify-center text-[10px] font-semibold",
										STATUS_COLORS[change.status],
									)}
								>
									{change.status}
								</span>
								<LineStats insertions={insertions} deletions={deletions} />
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
				);
			})}
		</div>
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
	file: InspectorFileItem;
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
