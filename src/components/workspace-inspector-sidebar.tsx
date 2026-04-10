import { MarkGithubIcon } from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	getMaterialFileIcon,
	getMaterialFolderIcon,
} from "file-extension-icon-js";
import {
	ArrowUpRightIcon,
	CheckIcon,
	ChevronDown,
	ChevronRightIcon,
	GitBranchIcon,
	MinusIcon,
	PlusIcon,
	TriangleIcon,
	Undo2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
	type ActionProvider,
	type ActionStatusKind,
	discardWorkspaceFile,
	getWorkspacePrCheckInsertText,
	type PullRequestInfo,
	stageWorkspaceFile,
	unstageWorkspaceFile,
	type WorkspaceGitActionStatus,
	type WorkspacePrActionItem,
	type WorkspacePrActionStatus,
} from "@/lib/api";
import { buildComposerPreviewPayload } from "@/lib/composer-insert";
import type { InspectorFileItem } from "@/lib/editor-session";
import {
	helmorQueryKeys,
	workspaceChangesQueryOptions,
	workspaceGitActionStatusQueryOptions,
	workspacePrActionStatusQueryOptions,
} from "@/lib/query-client";
import { cn } from "@/lib/utils";
import {
	AppendContextButton,
	type AppendContextPayloadResult,
} from "./append-context-button";
import { AnimatedShinyText } from "./ui/animated-shiny-text";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { NumberTicker } from "./ui/number-ticker";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import {
	type CommitButtonState,
	WorkspaceCommitButton,
	type WorkspaceCommitButtonMode,
} from "./workspace-commit-button";

const DEFAULT_CHANGES_RATIO = 0.6;
const DEFAULT_ACTIONS_RATIO = 0.4;
const MIN_SECTION_HEIGHT = 48;
const RESIZE_HIT_AREA = 10;

type WorkspaceInspectorSidebarProps = {
	workspaceId?: string | null;
	workspaceRootPath?: string | null;
	workspaceBranch?: string | null;
	workspaceTargetBranch?: string | null;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile(path: string): void;
	onOpenMockReview?: (path: string) => void;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	commitButtonMode?: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	/** Persistent PR info for the current workspace branch. Drives the
	 * "Git · PR #xxx" badge in the Git section header. */
	prInfo?: PullRequestInfo | null;
};

export function WorkspaceInspectorSidebar({
	workspaceId,
	workspaceRootPath,
	workspaceBranch,
	workspaceTargetBranch,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	onCommitAction,
	commitButtonMode,
	commitButtonState,
	prInfo,
}: WorkspaceInspectorSidebarProps) {
	const [tabsOpen, setTabsOpen] = useState(false);
	const [activeTab, setActiveTab] = useState("setup");
	const [changesHeight, setChangesHeight] = useState(0);
	const [actionsHeight, setActionsHeight] = useState(0);
	const [resizeState, setResizeState] = useState<{
		pointerY: number;
		initialChangesHeight: number;
		initialActionsHeight: number;
		target: "actions" | "tabs";
	} | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const tabsWrapperRef = useRef<HTMLDivElement>(null);
	const actionsRef = useRef<HTMLElement>(null);

	// Compute initial section heights from container size. Default to a 50/50
	// split between the top two sections; tabs still follow their own
	// expand/collapse behavior.
	useEffect(() => {
		const el = containerRef.current;
		if (!el || changesHeight > 0) return;
		// 3 section headers (h-9 = 36px each) + 2 resize handles (~8px each)
		const overhead = 36 * 3 + 8 * 2;
		const available = Math.max(0, el.clientHeight - overhead);
		// Reserve a minimum body height for the tabs section so its expand /
		// resize behavior remains intact, then split the remaining height 50/50
		// between Git and Actions by default.
		const resizableAvailable = Math.max(
			MIN_SECTION_HEIGHT * 2,
			available - MIN_SECTION_HEIGHT,
		);
		setChangesHeight(Math.round(resizableAvailable * DEFAULT_CHANGES_RATIO));
		setActionsHeight(Math.round(resizableAvailable * DEFAULT_ACTIONS_RATIO));
	}, [changesHeight]);

	const isResizing = resizeState !== null;
	const isActionsResizing = resizeState?.target === "actions";
	const isTabsResizing = resizeState?.target === "tabs";

	const changesQuery = useQuery({
		...workspaceChangesQueryOptions(workspaceRootPath ?? ""),
		enabled: !!workspaceRootPath,
	});
	const changes: InspectorFileItem[] = changesQuery.data?.items ?? [];

	// Track which file paths should flash (new or stats changed).
	// `null` means we haven't seen any data yet — skip flashing on first load.
	// IMPORTANT: useMemo body must remain pure under React 19 / Strict Mode
	// (memo cache may be discarded), so the snapshot is also computed via
	// useMemo and the ref update happens in a useEffect committed alongside.
	const prevChangesRef = useRef<Map<string, string> | null>(null);
	const prevRootPathRef = useRef(workspaceRootPath);
	if (prevRootPathRef.current !== workspaceRootPath) {
		prevRootPathRef.current = workspaceRootPath;
		prevChangesRef.current = null; // reset on workspace switch
	}
	const nextChangesSnapshot = useMemo(() => {
		const map = new Map<string, string>();
		for (const item of changes) {
			map.set(item.path, `${item.insertions}:${item.deletions}:${item.status}`);
		}
		return map;
	}, [changes]);
	const flashingPaths = useMemo(() => {
		const prevMap = prevChangesRef.current;
		// First load or workspace switch — don't flash
		if (prevMap === null) {
			return new Set<string>();
		}

		const flashing = new Set<string>();
		for (const item of changes) {
			const key = nextChangesSnapshot.get(item.path)!;
			const prev = prevMap.get(item.path);
			if (prev === undefined || prev !== key) {
				flashing.add(item.path);
			}
		}
		return flashing;
	}, [changes, nextChangesSnapshot]);
	useEffect(() => {
		// Commit the latest snapshot AFTER render so subsequent renders see it
		// as `prev`. This is the canonical "store the previous value" pattern.
		prevChangesRef.current = nextChangesSnapshot;
	}, [nextChangesSnapshot]);

	// Pre-warm Monaco file cache when changes data arrives
	useEffect(() => {
		const prefetched = changesQuery.data?.prefetched;
		if (!prefetched?.length) return;
		void import("@/lib/monaco-runtime").then(({ preWarmFileContents }) => {
			preWarmFileContents(prefetched);
		});
	}, [changesQuery.data]);

	const handleToggleTabs = useCallback(() => {
		const tabsEl = tabsWrapperRef.current;
		const actionsEl = actionsRef.current;
		if (!tabsEl) {
			setTabsOpen((v) => !v);
			return;
		}

		const tabsFrom = tabsEl.offsetHeight;
		const actionsFrom = actionsEl?.offsetHeight ?? 0;

		flushSync(() => setTabsOpen((v) => !v));

		const tabsTo = tabsEl.offsetHeight;
		const actionsTo = actionsEl?.offsetHeight ?? 0;
		if (tabsFrom === tabsTo) return;

		const isExpanding = tabsTo > tabsFrom;
		const opts = { duration: TABS_ANIMATION_MS, easing: TABS_EASING };

		// The element gaining flex-1 needs flex:none during animation,
		// otherwise flex-grow overrides the animated height.
		const animateSection = (
			el: HTMLElement,
			from: number,
			to: number,
			needsFlexOverride: boolean,
		) => {
			el.style.overflow = "hidden";
			if (needsFlexOverride) el.style.flex = "none";
			const anim = el.animate(
				[{ height: `${from}px` }, { height: `${to}px` }],
				opts,
			);
			anim.onfinish = anim.oncancel = () => {
				el.style.overflow = "";
				if (needsFlexOverride) el.style.flex = "";
			};
		};

		// Tabs gains flex-1 when expanding; Actions gains flex-1 when collapsing
		animateSection(tabsEl, tabsFrom, tabsTo, isExpanding);
		if (actionsEl && actionsFrom !== actionsTo) {
			animateSection(actionsEl, actionsFrom, actionsTo, !isExpanding);
		}
	}, []);

	useEffect(() => {
		if (!resizeState) return;

		// Throttle setState to once-per-frame via rAF — every pixel of
		// mousemove would otherwise re-render the entire inspector + Monaco
		// subtree.
		let pendingChanges: number | null = null;
		let pendingActions: number | null = null;
		let rafId: number | null = null;
		const flush = () => {
			rafId = null;
			if (pendingChanges !== null) {
				const next = pendingChanges;
				pendingChanges = null;
				setChangesHeight(next);
			}
			if (pendingActions !== null) {
				const next = pendingActions;
				pendingActions = null;
				setActionsHeight(next);
			}
		};

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			const deltaY = event.clientY - resizeState.pointerY;

			if (resizeState.target === "actions") {
				const nextChanges = Math.max(
					MIN_SECTION_HEIGHT,
					resizeState.initialChangesHeight + deltaY,
				);
				const actualDelta = nextChanges - resizeState.initialChangesHeight;
				const nextActions = Math.max(
					MIN_SECTION_HEIGHT,
					resizeState.initialActionsHeight - actualDelta,
				);
				pendingChanges = nextChanges;
				pendingActions = nextActions;
			} else {
				pendingActions = Math.max(
					MIN_SECTION_HEIGHT,
					resizeState.initialActionsHeight + deltaY,
				);
			}
			if (rafId === null) {
				rafId = window.requestAnimationFrame(flush);
			}
		};

		const handleMouseUp = () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
				rafId = null;
			}
			flush();
			setResizeState(null);
		};

		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = "ns-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
			}
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [resizeState]);

	const handleResizeStart = useCallback(
		(target: "actions" | "tabs") =>
			(event: React.MouseEvent<HTMLDivElement>) => {
				event.preventDefault();
				setResizeState({
					pointerY: event.clientY,
					initialChangesHeight: changesHeight,
					initialActionsHeight: actionsHeight,
					target,
				});
			},
		[changesHeight, actionsHeight],
	);

	return (
		<div
			ref={containerRef}
			className={cn(
				"flex h-full min-h-0 flex-col bg-sidebar",
				isResizing && "select-none",
			)}
		>
			<ChangesSection
				bodyHeight={changesHeight}
				workspaceId={workspaceId ?? null}
				workspaceRootPath={workspaceRootPath ?? null}
				workspaceBranch={workspaceBranch ?? null}
				workspaceTargetBranch={workspaceTargetBranch ?? null}
				changes={changes}
				editorMode={editorMode}
				activeEditorPath={activeEditorPath}
				onOpenEditorFile={onOpenEditorFile}
				flashingPaths={flashingPaths}
				onCommitAction={onCommitAction}
				commitButtonMode={commitButtonMode}
				commitButtonState={commitButtonState}
				prInfo={prInfo ?? null}
			/>

			<HorizontalResizeHandle
				onMouseDown={handleResizeStart("actions")}
				isActive={isActionsResizing}
			/>

			<ActionsSection
				workspaceId={workspaceId ?? null}
				sectionRef={actionsRef}
				bodyHeight={actionsHeight}
				expanded={!tabsOpen}
				onCommitAction={onCommitAction}
				commitButtonState={commitButtonState}
				prInfo={prInfo ?? null}
			/>

			{tabsOpen && (
				<HorizontalResizeHandle
					onMouseDown={handleResizeStart("tabs")}
					isActive={isTabsResizing}
				/>
			)}

			<InspectorTabsSection
				wrapperRef={tabsWrapperRef}
				open={tabsOpen}
				onToggle={handleToggleTabs}
				activeTab={activeTab}
				onTabChange={setActiveTab}
			/>
		</div>
	);
}

const TABS_ANIMATION_MS = 350;
const TABS_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

const INSPECTOR_SECTION_HEADER_CLASS =
	"flex h-9 min-w-0 shrink-0 items-center justify-between border-b border-border/60 bg-muted/25 px-3";
const INSPECTOR_SECTION_TITLE_CLASS =
	"inline-flex h-9 items-center text-[13px] font-medium tracking-[-0.01em] leading-none text-muted-foreground";

function getGitSectionHeaderHighlightClass(mode: WorkspaceCommitButtonMode) {
	switch (mode) {
		case "fix":
			return "bg-[color-mix(in_oklch,var(--destructive)_14%,var(--background)_86%)]";
		case "resolve-conflicts":
			return "bg-[color-mix(in_oklch,var(--chart-4)_14%,var(--background)_86%)]";
		case "merge":
			return "bg-[color-mix(in_oklch,var(--chart-2)_18%,var(--background)_82%)]";
		default:
			return null;
	}
}

function InspectorTabsSection({
	wrapperRef,
	open,
	onToggle,
	activeTab,
	onTabChange,
}: {
	wrapperRef: React.RefObject<HTMLDivElement | null>;
	open: boolean;
	onToggle: () => void;
	activeTab: string;
	onTabChange: (tab: string) => void;
}) {
	return (
		<div
			ref={wrapperRef}
			className={cn("flex min-h-0 shrink-0 flex-col", open && "flex-1")}
		>
			<section
				aria-label="Inspector section Tabs"
				className={cn(
					"relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar",
					open && "flex-1",
				)}
			>
				<Tabs
					value={activeTab}
					onValueChange={onTabChange}
					className={cn("flex min-h-0 flex-col gap-0", open && "flex-1")}
				>
					<div className={cn(INSPECTOR_SECTION_HEADER_CLASS, "relative z-10")}>
						<TabsList
							variant="line"
							className="h-9 gap-4 border-none bg-transparent p-0"
						>
							<TabsTrigger
								value="setup"
								className="h-9 w-auto gap-0 px-0 text-[12px] font-medium text-muted-foreground data-[state=active]:border-muted-foreground/80 data-[state=active]:bg-transparent data-[state=active]:text-foreground"
							>
								Setup
							</TabsTrigger>
							<TabsTrigger
								value="run"
								className="h-9 w-auto gap-0 px-0 text-[12px] font-medium text-muted-foreground data-[state=active]:border-muted-foreground/80 data-[state=active]:bg-transparent data-[state=active]:text-foreground"
							>
								Run
							</TabsTrigger>
						</TabsList>
						<Button
							type="button"
							aria-label="Toggle inspector tabs section"
							onClick={onToggle}
							variant="ghost"
							size="icon-sm"
							className="ml-auto shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
						>
							<ChevronDown
								className="size-3.5"
								strokeWidth={1.9}
								style={{
									transform: open ? "rotate(0deg)" : "rotate(-90deg)",
									transition: `transform ${TABS_ANIMATION_MS}ms ${TABS_EASING}`,
								}}
							/>
						</Button>
					</div>

					{open && (
						<div
							aria-label="Inspector tabs body"
							className="min-h-0 flex-1 bg-sidebar"
						/>
					)}
				</Tabs>
			</section>
		</div>
	);
}

function HorizontalResizeHandle({
	onMouseDown,
	isActive,
}: {
	onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
	isActive: boolean;
}) {
	return (
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-valuenow={0}
			onMouseDown={onMouseDown}
			className="group relative z-20 shrink-0 cursor-ns-resize touch-none"
			style={{
				height: `${RESIZE_HIT_AREA}px`,
				marginTop: `-${RESIZE_HIT_AREA / 2}px`,
				marginBottom: `-${RESIZE_HIT_AREA / 2}px`,
			}}
		>
			<span
				aria-hidden="true"
				className={`pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 transition-[height,background-color,box-shadow] ${
					isActive
						? "h-[2px] bg-foreground/80 shadow-[0_0_12px_rgba(0,0,0,0.12)] dark:shadow-[0_0_12px_rgba(255,255,255,0.16)]"
						: "h-px bg-border/75 group-hover:h-[2px] group-hover:bg-muted-foreground/75"
				}`}
			/>
		</div>
	);
}

// -- Actions section --

interface GitStatusItem {
	label: string;
	status: ActionStatusKind;
	action?: {
		label: string;
		mode: WorkspaceCommitButtonMode;
	};
}

const EMPTY_GIT_ACTION_STATUS: WorkspaceGitActionStatus = {
	uncommittedCount: 0,
	conflictCount: 0,
};

const EMPTY_PR_ACTION_STATUS: WorkspacePrActionStatus = {
	pr: null,
	reviewDecision: null,
	mergeable: null,
	deployments: [],
	checks: [],
	remoteState: "unavailable",
	message: null,
};

function ProviderIcon({ provider }: { provider: ActionProvider }) {
	if (provider === "vercel") {
		return (
			<TriangleIcon
				className="size-3 shrink-0 fill-current text-muted-foreground"
				strokeWidth={0}
			/>
		);
	}
	if (provider === "unknown") return null;
	return (
		<MarkGithubIcon size={12} className="shrink-0 text-muted-foreground" />
	);
}

function StatusIcon({ status }: { status: ActionStatusKind }) {
	if (status === "success") {
		return (
			<CheckIcon
				aria-label="Passed"
				className="size-3 shrink-0 text-chart-2"
				strokeWidth={2.2}
			/>
		);
	}

	const label =
		status === "running"
			? "Running"
			: status === "failure"
				? "Failed"
				: "Pending";
	const color =
		status === "running"
			? "rgb(245, 158, 11)"
			: status === "failure"
				? "rgb(207, 34, 46)"
				: undefined;

	return (
		<span
			aria-label={label}
			className="inline-flex size-3 shrink-0 items-center justify-center rounded-full border border-current text-muted-foreground"
			style={color ? { color } : undefined}
		>
			<span
				className={cn(
					"size-1.5 rounded-full",
					status === "pending" && "bg-muted-foreground",
				)}
				style={color ? { backgroundColor: color } : undefined}
			/>
		</span>
	);
}

function buildGitStatusRows(
	gitStatus: WorkspaceGitActionStatus,
	prStatus: WorkspacePrActionStatus,
	prInfo: PullRequestInfo | null,
): GitStatusItem[] {
	const uncommittedCount = gitStatus.uncommittedCount;
	const conflictCount = gitStatus.conflictCount;
	const hasMergeConflict =
		conflictCount > 0 || prStatus.mergeable === "CONFLICTING";
	const pr = prStatus.pr ?? prInfo;
	const isMerged = pr?.isMerged ?? false;

	const rows: GitStatusItem[] = [
		uncommittedCount === 0
			? {
					label: "No uncommitted changes",
					status: "success",
				}
			: {
					label:
						uncommittedCount === 1
							? "1 uncommitted change"
							: `${uncommittedCount} uncommitted changes`,
					status: "pending",
					action: {
						label: "Commit and push",
						mode: "commit-and-push",
					},
				},
		hasMergeConflict
			? {
					label: "Merge conflicts detected",
					status: "failure",
					action: {
						label: "Resolve",
						mode: "resolve-conflicts",
					},
				}
			: {
					label: "No merge conflicts",
					status: "success",
				},
	];

	if (isMerged || prStatus.reviewDecision === "APPROVED") {
		rows.push({ label: "Review approved", status: "success" });
	} else if (pr?.state === "CLOSED") {
		rows.push({ label: "PR closed", status: "failure" });
	} else if (prStatus.reviewDecision === "CHANGES_REQUESTED") {
		rows.push({ label: "Changes requested", status: "failure" });
	} else {
		rows.push({ label: "Waiting for PR review", status: "pending" });
	}

	return rows;
}

function ActionsSection({
	workspaceId,
	sectionRef,
	bodyHeight,
	expanded,
	onCommitAction,
	commitButtonState,
	prInfo,
}: {
	workspaceId: string | null;
	sectionRef?: React.RefObject<HTMLElement | null>;
	bodyHeight: number;
	expanded: boolean;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	commitButtonState?: CommitButtonState;
	prInfo: PullRequestInfo | null;
}) {
	const gitStatusQuery = useQuery({
		...workspaceGitActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const prStatusQuery = useQuery({
		...workspacePrActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const gitStatus = gitStatusQuery.data ?? EMPTY_GIT_ACTION_STATUS;
	const prStatus = prStatusQuery.data ?? EMPTY_PR_ACTION_STATUS;
	const gitRows = buildGitStatusRows(gitStatus, prStatus, prInfo);
	const actionDisabled = commitButtonState === "busy";
	const handleInsertCheck = useCallback(
		async (item: WorkspacePrActionItem) => {
			if (!workspaceId) return;
			const submitText = await getWorkspacePrCheckInsertText(
				workspaceId,
				item.id,
			);
			return {
				target: { workspaceId },
				label: item.name,
				submitText,
				key: `pr-check:${item.id}`,
				preview: buildComposerPreviewPayload({
					title: item.name,
					content: submitText,
					preferredKind: "code",
				}),
			};
		},
		[workspaceId],
	);

	return (
		<section
			ref={sectionRef}
			aria-label="Inspector section Actions"
			className={cn(
				"flex min-h-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar",
				expanded && "flex-1",
			)}
		>
			<div className={INSPECTOR_SECTION_HEADER_CLASS}>
				<span className={INSPECTOR_SECTION_TITLE_CLASS}>Actions</span>
			</div>

			<ScrollArea
				aria-label="Actions panel body"
				className={cn("bg-muted/18 text-[11.5px]", expanded && "flex-1")}
				style={expanded ? undefined : { height: `${bodyHeight}px` }}
			>
				{/* Git status */}
				<div className="px-2.5 pb-1 pt-2">
					<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
						Git status
					</span>
				</div>
				{gitRows.map((item) => {
					const action = item.action;
					return (
						<div
							key={item.label}
							className="flex items-center gap-1.5 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60"
						>
							<StatusIcon status={item.status} />
							<span className="truncate">{item.label}</span>
							{action && (
								<button
									type="button"
									disabled={actionDisabled}
									onClick={() => {
										if (actionDisabled) return;
										void onCommitAction?.(action.mode);
									}}
									className="ml-auto shrink-0 cursor-pointer text-[10.5px] text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
								>
									{action.label}
								</button>
							)}
						</div>
					);
				})}

				{/* Deployments */}
				{prStatus.deployments.length > 0 && (
					<>
						<div className="px-2.5 pb-1 pt-2.5">
							<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
								Deployments
							</span>
						</div>
						{prStatus.deployments.map((item) => (
							<ActionStatusRow key={item.id} item={item} />
						))}
					</>
				)}

				{/* Checks */}
				{prStatus.checks.length > 0 && (
					<>
						<div className="px-2.5 pb-1 pt-2.5">
							<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
								Checks
							</span>
						</div>
						{prStatus.checks.map((item) => (
							<ActionStatusRow
								key={item.id}
								item={item}
								onInsertToComposer={handleInsertCheck}
							/>
						))}
					</>
				)}
			</ScrollArea>
		</section>
	);
}

function ActionStatusRow({
	item,
	onInsertToComposer,
}: {
	item: WorkspacePrActionItem;
	onInsertToComposer?: (
		item: WorkspacePrActionItem,
	) => AppendContextPayloadResult | Promise<AppendContextPayloadResult>;
}) {
	return (
		<div className="group/check-row flex items-center justify-between gap-3 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60">
			<div className="flex min-w-0 items-center gap-1.5">
				<StatusIcon status={item.status} />
				<ProviderIcon provider={item.provider} />
				<span className="truncate text-primary">{item.name}</span>
				{item.duration && (
					<span className="shrink-0 text-[10.5px] text-muted-foreground">
						{item.duration}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-1.5">
				{onInsertToComposer && (
					<AppendContextButton
						subjectLabel={item.name}
						getPayload={() => onInsertToComposer(item)}
						errorTitle="Couldn't insert check"
						className={cn(
							"text-primary hover:bg-accent/60 hover:text-primary",
							"opacity-0 group-hover/check-row:opacity-100 focus-visible:opacity-100",
						)}
					/>
				)}
				{item.url && (
					<button
						type="button"
						aria-label={`Open ${item.name}`}
						onClick={() => void openUrl(item.url!)}
						className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
					>
						<ArrowUpRightIcon className="size-3" strokeWidth={1.8} />
					</button>
				)}
			</div>
		</div>
	);
}

// -- Changes section with file tree / flat list toggle --

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
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					path: parts.slice(0, i + 1).join("/"),
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

const STATUS_COLORS: Record<InspectorFileItem["status"], string> = {
	M: "text-yellow-500",
	A: "text-green-500",
	D: "text-red-500",
};

function ChangesSection({
	bodyHeight,
	workspaceId,
	workspaceRootPath,
	workspaceBranch,
	workspaceTargetBranch,
	changes,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
	onCommitAction,
	commitButtonMode = "create-pr",
	commitButtonState,
	prInfo,
}: {
	bodyHeight: number;
	workspaceId: string | null;
	workspaceRootPath: string | null;
	workspaceBranch: string | null;
	workspaceTargetBranch: string | null;
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
	flashingPaths: Set<string>;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	commitButtonMode?: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	prInfo: PullRequestInfo | null;
}) {
	const queryClient = useQueryClient();
	const [treeView] = useState(true);
	const [changesOpen, setChangesOpen] = useState(true);
	const [stagedOpen, setStagedOpen] = useState(true);
	const [branchDiffOpen, setBranchDiffOpen] = useState(true);

	// Classify files into Staged Changes / Changes groups using the
	// per-state status fields from the backend. A file with both staged and
	// unstaged modifications appears in both groups, mirroring git's view.
	const stagedChanges = useMemo(
		() =>
			changes
				.filter((c) => c.stagedStatus != null)
				.map((c) => ({ ...c, status: c.stagedStatus ?? c.status })),
		[changes],
	);
	const unstagedChanges = useMemo(
		() =>
			changes
				.filter((c) => c.unstagedStatus != null)
				.map((c) => ({ ...c, status: c.unstagedStatus ?? c.status })),
		[changes],
	);
	// Branch diff: files that have committed changes (merge-base..HEAD) —
	// the persistent view of "what does this branch / PR contain?".
	const committedChanges = useMemo(
		() =>
			changes
				.filter((c) => c.committedStatus != null)
				.map((c) => ({ ...c, status: c.committedStatus ?? c.status })),
		[changes],
	);
	const hasUncommittedChanges =
		stagedChanges.length > 0 || unstagedChanges.length > 0;
	const hasChanges = hasUncommittedChanges || committedChanges.length > 0;
	const invalidateChanges = useCallback(() => {
		if (!workspaceRootPath) return;
		queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.workspaceChanges(workspaceRootPath),
		});
		if (workspaceId) {
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
			});
		}
	}, [queryClient, workspaceId, workspaceRootPath]);

	const stageFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) return;
			try {
				await stageWorkspaceFile(workspaceRootPath, relativePath);
			} finally {
				invalidateChanges();
			}
		},
		[workspaceRootPath, invalidateChanges],
	);
	const unstageFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) return;
			try {
				await unstageWorkspaceFile(workspaceRootPath, relativePath);
			} finally {
				invalidateChanges();
			}
		},
		[workspaceRootPath, invalidateChanges],
	);

	const stageAll = useCallback(async () => {
		if (!workspaceRootPath) return;
		const paths = unstagedChanges.map((c) => c.path);
		try {
			// Run sequentially to keep git index access serialized.
			for (const p of paths) {
				await stageWorkspaceFile(workspaceRootPath, p);
			}
		} finally {
			invalidateChanges();
		}
	}, [workspaceRootPath, unstagedChanges, invalidateChanges]);
	const unstageAll = useCallback(async () => {
		if (!workspaceRootPath) return;
		const paths = stagedChanges.map((c) => c.path);
		try {
			for (const p of paths) {
				await unstageWorkspaceFile(workspaceRootPath, p);
			}
		} finally {
			invalidateChanges();
		}
	}, [workspaceRootPath, stagedChanges, invalidateChanges]);

	const discardFile = useCallback(
		async (relativePath: string) => {
			if (!workspaceRootPath) return;
			try {
				await discardWorkspaceFile(workspaceRootPath, relativePath);
			} finally {
				invalidateChanges();
			}
		},
		[workspaceRootPath, invalidateChanges],
	);

	// Mode + state are owned by App's commit button lifecycle driver. It
	// rotates the mode after a successful action (e.g. create-pr → merge)
	// and drives the busy / done / error transitions across multiple phases.
	const gitHeaderHighlightClass =
		getGitSectionHeaderHighlightClass(commitButtonMode);

	const handleCommitButtonClick = useCallback(async () => {
		if (!onCommitAction) return;
		await onCommitAction(commitButtonMode);
	}, [onCommitAction, commitButtonMode]);

	return (
		<section
			aria-label="Inspector section Git"
			className="flex min-h-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar"
			style={{ height: `${bodyHeight}px` }}
		>
			<div
				className={cn(INSPECTOR_SECTION_HEADER_CLASS, gitHeaderHighlightClass)}
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<span className={INSPECTOR_SECTION_TITLE_CLASS}>Git</span>
					{prInfo && (
						<Button
							type="button"
							variant="outline"
							size="xs"
							onClick={() => {
								void openUrl(prInfo.url);
							}}
							className={cn(
								"h-5.5 gap-0.5 rounded-[3px] px-2 text-[11px] font-semibold leading-none tracking-[0.01em]",
								prInfo.isMerged
									? "border-[#8957E5]/45 bg-transparent text-[#8957E5] hover:border-[#8957E5]/65 hover:text-[#8957E5]"
									: prInfo.state === "OPEN"
										? "border-[rgb(22_163_74)]/55 text-[rgb(22_163_74)] hover:border-[rgb(22_163_74)]/70 hover:text-[rgb(22_163_74)]"
										: "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
							)}
						>
							PR #{prInfo.number}
						</Button>
					)}
				</div>
				{(hasChanges ||
					commitButtonState === "busy" ||
					commitButtonMode !== "create-pr") && (
					<WorkspaceCommitButton
						mode={commitButtonMode}
						state={commitButtonState}
						className="my-0.5 ml-auto"
						onCommit={handleCommitButtonClick}
					/>
				)}
			</div>

			<ScrollArea
				aria-label="Changes panel body"
				className="bg-muted/20 font-mono text-[11.5px] flex-1 min-h-0"
			>
				{/* Uncommitted changes: staged + unstaged (auto-hide when empty) */}
				{hasUncommittedChanges && (
					<>
						{stagedChanges.length > 0 && (
							<ChangesGroup
								label="Staged Changes"
								count={stagedChanges.length}
								open={stagedOpen}
								onToggle={() => setStagedOpen((v) => !v)}
								changes={stagedChanges}
								treeView={treeView}
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
								count={unstagedChanges.length}
								open={changesOpen}
								onToggle={() => setChangesOpen((v) => !v)}
								changes={unstagedChanges}
								treeView={treeView}
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

				{/* Branch diff: committed changes (merge-base..HEAD).
				    Always visible — this is the persistent "what does this PR contain?" view. */}
				{committedChanges.length > 0 && (
					<BranchDiffSection
						branch={workspaceBranch}
						targetBranch={workspaceTargetBranch}
						count={committedChanges.length}
						open={branchDiffOpen}
						onToggle={() => setBranchDiffOpen((v) => !v)}
						changes={committedChanges}
						treeView={treeView}
						editorMode={editorMode}
						activeEditorPath={activeEditorPath}
						onOpenEditorFile={onOpenEditorFile}
						flashingPaths={flashingPaths}
					/>
				)}

				{/* Empty state: no uncommitted changes AND no branch diff */}
				{!hasChanges && (
					<div className="px-3 py-3 text-[11px] leading-5 text-muted-foreground">
						No changes on this branch yet.
					</div>
				)}
			</ScrollArea>
		</section>
	);
}

type StageActionKind = "stage" | "unstage";

function ChangesGroup({
	label,
	count,
	open,
	onToggle,
	changes,
	treeView,
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
	count: number;
	open: boolean;
	onToggle: () => void;
	changes: InspectorFileItem[];
	treeView: boolean;
	action: StageActionKind;
	onStageAction: (path: string) => void;
	onBatchAction?: () => void;
	onDiscard?: (path: string) => void;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
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
					className="h-auto min-w-0 flex-1 justify-start gap-1 rounded-none px-0 text-left hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground"
				>
					<ChevronRightIcon
						data-icon="inline-start"
						className={cn(
							"size-3 shrink-0 transition-transform",
							open && "rotate-90",
						)}
						strokeWidth={2}
					/>
					<span className="truncate">{label}</span>
				</Button>
				{onBatchAction && (
					<RowIconButton
						aria-label={
							action === "stage" ? "Stage all changes" : "Unstage all changes"
						}
						onClick={onBatchAction}
						className="opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
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

/** Branch diff section — shows files changed on the current branch relative to
 * the target branch (merge-base..HEAD). Always visible when there are committed
 * changes, sits below the uncommitted Staged/Changes groups. */
function BranchDiffSection({
	branch,
	targetBranch,
	count,
	open,
	onToggle,
	changes,
	treeView,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
}: {
	branch: string | null;
	targetBranch: string | null;
	count: number;
	open: boolean;
	onToggle: () => void;
	changes: InspectorFileItem[];
	treeView: boolean;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
	flashingPaths: Set<string>;
}) {
	const branchLabel = branch ?? "HEAD";
	const targetLabel = targetBranch ?? "main";

	return (
		<div>
			<div className="group/header flex w-full items-center gap-1 py-1 pl-1 pr-2 text-[11.5px] font-semibold tracking-[-0.01em] text-muted-foreground">
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={onToggle}
					aria-expanded={open}
					className="h-auto min-w-0 flex-1 justify-start gap-1 rounded-none px-0 text-left hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground"
				>
					<ChevronRightIcon
						data-icon="inline-start"
						className={cn(
							"size-3 shrink-0 transition-transform",
							open && "rotate-90",
						)}
						strokeWidth={2}
					/>
					<GitBranchIcon
						className="size-3 shrink-0 text-muted-foreground"
						strokeWidth={2}
					/>
					<span className="flex min-w-0 items-center truncate">
						<span className="truncate">{branchLabel}</span>
						<span className="mx-1 shrink-0 text-muted-foreground">→</span>
						<span className="shrink-0">{targetLabel}</span>
					</span>
				</Button>
				<Badge
					variant="secondary"
					className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none"
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
						/>
					) : (
						<ChangesFlatView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={onOpenEditorFile}
							flashingPaths={flashingPaths}
						/>
					)}
				</div>
			)}
		</div>
	);
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
	onOpenEditorFile: (path: string) => void;
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
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
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
	onOpenEditorFile: (path: string) => void;
	flashingPaths: Set<string>;
	action?: StageActionKind;
	onStageAction?: (path: string) => void;
	onDiscard?: (path: string) => void;
}) {
	const sorted = [...nodes.values()].sort((a, b) => {
		const aIsFolder = a.children.size > 0 && !a.file;
		const bIsFolder = b.children.size > 0 && !b.file;
		if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
		return a.name.localeCompare(b.name);
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
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") onToggle(node.path);
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
						style={{ paddingLeft: `${depth * 12 + 8 + 14}px` }}
						role="treeitem"
						tabIndex={0}
						onClick={() => file && onOpenEditorFile(file.absolutePath)}
						onKeyDown={(event) => {
							if ((event.key === "Enter" || event.key === " ") && file) {
								event.preventDefault();
								onOpenEditorFile(file.absolutePath);
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
	onOpenEditorFile: (path: string) => void;
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
					onClick={() => onOpenEditorFile(change.absolutePath)}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onOpenEditorFile(change.absolutePath);
						}
					}}
				>
					<img
						src={getMaterialFileIcon(change.name)}
						alt=""
						className="size-4 shrink-0"
					/>
					<ShinyFlash active={flashingPaths.has(change.path)}>
						{change.name}
					</ShinyFlash>
					<span
						className={cn(
							"ml-auto shrink-0 truncate text-[10px] text-muted-foreground",
							hasAction && "group-hover/row:hidden",
						)}
					>
						{change.path.slice(0, change.path.lastIndexOf("/"))}
					</span>
					<span
						className={cn(
							"flex shrink-0 items-center gap-1.5",
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

function LineStats({
	insertions,
	deletions,
}: {
	insertions: number;
	deletions: number;
}) {
	if (insertions === 0 && deletions === 0) return null;

	return (
		<span className="flex shrink-0 items-center gap-1 text-[10px]">
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

/** Applies animated-shiny-text shimmer when `active` flips to true, then fades back. */
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
		if (!active) return;
		counterRef.current += 1;
		setShimmer(true);
		const id = window.setTimeout(() => setShimmer(false), 3000);
		return () => window.clearTimeout(id);
	}, [active]);

	if (!shimmer) {
		return <span className="truncate">{children}</span>;
	}

	return (
		<AnimatedShinyText
			key={counterRef.current}
			shimmerWidth={60}
			className="!mx-0 !max-w-none truncate !text-neutral-500/80 dark:!text-neutral-500/80 ![animation-name:shiny-text-continuous] [animation-duration:1s] [animation-iteration-count:3] [animation-timing-function:ease-in-out] dark:via-white via-black"
		>
			{children}
		</AnimatedShinyText>
	);
}
