import { MarkGithubIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import {
	getMaterialFileIcon,
	getMaterialFolderIcon,
} from "file-extension-icon-js";
import {
	ArrowUpRightIcon,
	CheckIcon,
	ChevronDown,
	ChevronRightIcon,
	CircleIcon,
	ListIcon,
	ListTreeIcon,
	TriangleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { InspectorFileItem } from "@/lib/editor-session";
import { workspaceChangesQueryOptions } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { AnimatedShinyText } from "./ui/animated-shiny-text";
import { NumberTicker } from "./ui/number-ticker";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

const DEFAULT_CHANGES_RATIO = 0.4;
const DEFAULT_ACTIONS_RATIO = 0.3;
const MIN_SECTION_HEIGHT = 48;
const RESIZE_HIT_AREA = 8;

type WorkspaceInspectorSidebarProps = {
	workspaceRootPath?: string | null;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile(path: string): void;
	onOpenMockReview?: (path: string) => void;
};

export function WorkspaceInspectorSidebar({
	workspaceRootPath,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
}: WorkspaceInspectorSidebarProps) {
	const [tabsOpen, setTabsOpen] = useState(true);
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

	// Compute initial section heights from container size (40/30/30 ratio)
	useEffect(() => {
		const el = containerRef.current;
		if (!el || changesHeight > 0) return;
		// 3 section headers (h-9 = 36px each) + 2 resize handles (~8px each)
		const overhead = 36 * 3 + 8 * 2;
		const available = Math.max(0, el.clientHeight - overhead);
		setChangesHeight(Math.round(available * DEFAULT_CHANGES_RATIO));
		setActionsHeight(Math.round(available * DEFAULT_ACTIONS_RATIO));
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
				"flex h-full min-h-0 flex-col border-l border-app-border/70 bg-app-sidebar",
				isResizing && "select-none",
			)}
		>
			<ChangesSection
				bodyHeight={changesHeight}
				changes={changes}
				editorMode={editorMode}
				activeEditorPath={activeEditorPath}
				onOpenEditorFile={onOpenEditorFile}
				flashingPaths={flashingPaths}
			/>

			<HorizontalResizeHandle
				onMouseDown={handleResizeStart("actions")}
				isActive={isActionsResizing}
			/>

			<ActionsSection
				sectionRef={actionsRef}
				bodyHeight={actionsHeight}
				expanded={!tabsOpen}
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
			className={cn("flex min-h-0 flex-col", open && "flex-1")}
		>
			<section
				aria-label="Inspector section Tabs"
				className="flex min-h-0 flex-1 flex-col border-b border-app-border/60 bg-app-sidebar"
			>
				<Tabs
					value={activeTab}
					onValueChange={onTabChange}
					className="flex min-h-0 flex-1 flex-col gap-0"
				>
					<div className="flex h-9 min-w-0 shrink-0 items-center border-b border-app-border/60 bg-app-base/[0.3] pl-1.5 pr-2">
						<button
							type="button"
							aria-label="Toggle inspector tabs section"
							onClick={onToggle}
							className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-app-foreground-soft outline-none transition-colors hover:bg-app-foreground/[0.04]"
						>
							<ChevronDown
								className="size-3.5"
								strokeWidth={1.9}
								style={{
									transform: open ? "rotate(0deg)" : "rotate(-90deg)",
									transition: `transform ${TABS_ANIMATION_MS}ms ${TABS_EASING}`,
								}}
							/>
						</button>

						<TabsList
							variant="line"
							className="h-9 gap-0 border-none bg-transparent p-0"
						>
							<TabsTrigger
								value="setup"
								variant="line"
								className="h-9 w-auto gap-0 px-2.5 text-[12px] font-medium text-app-foreground-soft data-[state=active]:border-app-foreground-soft/80 data-[state=active]:bg-transparent data-[state=active]:text-app-foreground"
							>
								Setup
							</TabsTrigger>
							<TabsTrigger
								value="run"
								variant="line"
								className="h-9 w-auto gap-0 px-2.5 text-[12px] font-medium text-app-foreground-soft data-[state=active]:border-app-foreground-soft/80 data-[state=active]:bg-transparent data-[state=active]:text-app-foreground"
							>
								Run
							</TabsTrigger>
						</TabsList>
					</div>

					{open && (
						<div
							aria-label="Inspector tabs body"
							className="min-h-0 flex-1 bg-app-base/[0.16]"
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
			className="group relative z-10 cursor-ns-resize touch-none"
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
						? "h-[2px] bg-app-foreground/80 shadow-[0_0_12px_rgba(250,249,246,0.2)]"
						: "h-px bg-transparent group-hover:h-[2px] group-hover:bg-app-foreground-soft/75 group-hover:shadow-[0_0_10px_rgba(250,249,246,0.08)]"
				}`}
			/>
		</div>
	);
}

// -- Actions section --

interface GitStatusItem {
	label: string;
	action?: string;
}

interface DeploymentItem {
	name: string;
	provider: "vercel";
	status: "success" | "pending" | "failure";
	hasLink?: boolean;
}

interface CheckItem {
	name: string;
	provider: "github" | "vercel";
	status: "success" | "pending" | "failure";
	duration?: string;
	hasLink?: boolean;
}

const MOCK_GIT_STATUS: GitStatusItem[] = [
	{ label: "1 uncommitted change", action: "Commit and push" },
	{ label: "Merge conflicts detected", action: "Resolve" },
	{ label: "Waiting for PR review" },
];

const MOCK_DEPLOYMENTS: DeploymentItem[] = [
	{ name: "marketing", provider: "vercel", status: "success", hasLink: true },
];

const MOCK_CHECKS: CheckItem[] = [
	{ name: "changes", provider: "github", status: "success", duration: "12s" },
	{
		name: "staging-locked",
		provider: "github",
		status: "success",
		duration: "6s",
	},
	{ name: "Deploy to Staging", provider: "github", status: "success" },
	{
		name: "Vercel Agent Review",
		provider: "vercel",
		status: "success",
		duration: "1s",
		hasLink: true,
	},
	{
		name: "Seer Code Review",
		provider: "github",
		status: "success",
		duration: "2m",
		hasLink: true,
	},
	{
		name: "Vercel Preview Comments",
		provider: "vercel",
		status: "success",
		duration: "0s",
		hasLink: true,
	},
	{
		name: "Vercel – app",
		provider: "vercel",
		status: "success",
		hasLink: true,
	},
	{
		name: "Vercel – app-emails-preview",
		provider: "vercel",
		status: "success",
		hasLink: true,
	},
	{
		name: "Vercel – design-system",
		provider: "vercel",
		status: "success",
		hasLink: true,
	},
	{
		name: "Vercel – knows",
		provider: "vercel",
		status: "success",
		hasLink: true,
	},
	{
		name: "Vercel – marketing",
		provider: "vercel",
		status: "success",
		hasLink: true,
	},
];

function ProviderIcon({ provider }: { provider: "github" | "vercel" }) {
	if (provider === "vercel") {
		return (
			<TriangleIcon
				className="size-3 shrink-0 fill-current text-app-foreground-soft"
				strokeWidth={0}
			/>
		);
	}
	return (
		<MarkGithubIcon size={12} className="shrink-0 text-app-foreground-soft" />
	);
}

function StatusIcon({ status }: { status: "success" | "pending" | "failure" }) {
	if (status === "success") {
		return (
			<CheckIcon className="size-3 shrink-0 text-green-500" strokeWidth={2.2} />
		);
	}
	return (
		<CircleIcon className="size-3 shrink-0 text-app-muted" strokeWidth={1.5} />
	);
}

function ActionsSection({
	sectionRef,
	bodyHeight,
	expanded,
}: {
	sectionRef?: React.RefObject<HTMLElement | null>;
	bodyHeight: number;
	expanded: boolean;
}) {
	return (
		<section
			ref={sectionRef}
			aria-label="Inspector section Actions"
			className={cn(
				"flex min-h-0 flex-col border-b border-app-border/60 bg-app-sidebar",
				expanded && "flex-1",
			)}
		>
			<div className="flex h-9 min-w-0 shrink-0 items-center border-b border-app-border/60 bg-app-base/[0.3] px-3">
				<span className="inline-flex h-9 items-center text-[13px] font-medium tracking-[-0.01em] text-app-foreground-soft">
					Actions
				</span>
			</div>

			<ScrollArea
				aria-label="Actions panel body"
				className={cn("bg-app-base/[0.16] text-[11.5px]", expanded && "flex-1")}
				style={expanded ? undefined : { height: `${bodyHeight}px` }}
			>
				{/* Git status */}
				<div className="px-2.5 pb-1 pt-2">
					<span className="text-[10.5px] font-medium tracking-wide text-app-muted">
						Git status
					</span>
				</div>
				{MOCK_GIT_STATUS.map((item) => (
					<div
						key={item.label}
						className="flex items-center gap-1.5 px-2.5 py-[3px] text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.04]"
					>
						<CircleIcon
							className="size-3 shrink-0 text-app-muted"
							strokeWidth={1.5}
						/>
						<span className="truncate">{item.label}</span>
						{item.action && (
							<span className="ml-auto shrink-0 cursor-pointer text-[10.5px] text-app-muted transition-colors hover:text-app-foreground">
								{item.action}
							</span>
						)}
					</div>
				))}

				{/* Deployments */}
				<div className="px-2.5 pb-1 pt-2.5">
					<span className="text-[10.5px] font-medium tracking-wide text-app-muted">
						Deployments
					</span>
				</div>
				{MOCK_DEPLOYMENTS.map((item) => (
					<div
						key={item.name}
						className="flex items-center gap-1.5 px-2.5 py-[3px] text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.04]"
					>
						<StatusIcon status={item.status} />
						<ProviderIcon provider={item.provider} />
						<span className="truncate">{item.name}</span>
						{item.hasLink && (
							<ArrowUpRightIcon
								className="ml-auto size-3 shrink-0 text-app-muted"
								strokeWidth={1.8}
							/>
						)}
					</div>
				))}

				{/* Checks */}
				<div className="px-2.5 pb-1 pt-2.5">
					<span className="text-[10.5px] font-medium tracking-wide text-app-muted">
						Checks
					</span>
				</div>
				{MOCK_CHECKS.map((item) => (
					<div
						key={item.name}
						className="flex items-center gap-1.5 px-2.5 py-[3px] text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.04]"
					>
						<StatusIcon status={item.status} />
						<ProviderIcon provider={item.provider} />
						<span className="truncate">{item.name}</span>
						{item.duration && (
							<span className="shrink-0 text-[10.5px] text-app-muted">
								{item.duration}
							</span>
						)}
						{item.hasLink && (
							<ArrowUpRightIcon
								className={cn(
									"size-3 shrink-0 text-app-muted",
									!item.duration && "ml-auto",
								)}
								strokeWidth={1.8}
							/>
						)}
					</div>
				))}
			</ScrollArea>
		</section>
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
	changes,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
}: {
	bodyHeight: number;
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
	flashingPaths: Set<string>;
}) {
	const [treeView, setTreeView] = useState(true);

	return (
		<section
			aria-label="Inspector section Changes"
			className="flex min-h-0 flex-col border-b border-app-border/60 bg-app-sidebar"
		>
			<div className="flex h-9 min-w-0 items-center justify-between border-b border-app-border/60 bg-app-base/[0.3] px-3">
				<span className="inline-flex h-9 items-center text-[13px] font-medium tracking-[-0.01em] text-app-foreground-soft">
					Changes
				</span>
				{treeView ? (
					<ListIcon
						className="size-3.5 cursor-pointer text-app-foreground-soft transition-colors hover:text-app-foreground"
						strokeWidth={1.8}
						onClick={() => setTreeView(false)}
					/>
				) : (
					<ListTreeIcon
						className="size-3.5 cursor-pointer text-app-foreground-soft transition-colors hover:text-app-foreground"
						strokeWidth={1.8}
						onClick={() => setTreeView(true)}
					/>
				)}
			</div>

			<ScrollArea
				aria-label="Changes panel body"
				className="bg-app-base/[0.16] font-mono text-[11.5px]"
				style={{ height: `${bodyHeight}px` }}
			>
				{changes.length > 0 ? (
					treeView ? (
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
					)
				) : (
					<div className="px-3 py-3 text-[11px] leading-5 text-app-muted">
						Select a workspace with a root path to open files here.
					</div>
				)}
			</ScrollArea>
		</section>
	);
}

function ChangesTreeView({
	changes,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	flashingPaths,
}: {
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
	flashingPaths: Set<string>;
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
}: {
	nodes: Map<string, ReturnType<typeof buildTree>>;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	depth: number;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
	flashingPaths: Set<string>;
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
								className="flex cursor-pointer items-center gap-1 py-[1.5px] pr-2 text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.04]"
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
								/>
							)}
						</div>
					);
				}

				const selected = node.file?.absolutePath === activeEditorPath;
				const isFlashing = !!node.file && flashingPaths.has(node.file.path);

				return (
					<div
						key={node.path}
						className={cn(
							"flex cursor-pointer items-center gap-1 py-[1.5px] pr-2 text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.04]",
							selected &&
								(editorMode
									? "bg-app-row-selected text-app-foreground"
									: "bg-app-foreground/[0.05] text-app-foreground"),
						)}
						style={{ paddingLeft: `${depth * 12 + 8 + 14}px` }}
						role="treeitem"
						tabIndex={0}
						onClick={() =>
							node.file && onOpenEditorFile(node.file.absolutePath)
						}
						onKeyDown={(event) => {
							if ((event.key === "Enter" || event.key === " ") && node.file) {
								event.preventDefault();
								onOpenEditorFile(node.file.absolutePath);
							}
						}}
					>
						<img
							src={getMaterialFileIcon(node.name)}
							alt=""
							className="size-4 shrink-0"
						/>
						<ShinyFlash active={isFlashing}>{node.name}</ShinyFlash>
						{node.file && (
							<span className="ml-auto flex shrink-0 items-center gap-1.5">
								<LineStats
									insertions={node.file.insertions}
									deletions={node.file.deletions}
								/>
								<span
									className={cn(
										"text-[10px] font-semibold",
										STATUS_COLORS[node.file.status],
									)}
								>
									{node.file.status}
								</span>
							</span>
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
}: {
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
	flashingPaths: Set<string>;
}) {
	return (
		<div className="py-0.5">
			{changes.map((change) => (
				<div
					key={change.path}
					className={cn(
						"flex cursor-pointer items-center gap-1.5 py-[1.5px] pl-2 pr-2 text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.04]",
						change.absolutePath === activeEditorPath &&
							(editorMode
								? "bg-app-row-selected text-app-foreground"
								: "bg-app-foreground/[0.05] text-app-foreground"),
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
					<span className="ml-auto shrink-0 truncate text-[10px] text-app-muted">
						{change.path.slice(0, change.path.lastIndexOf("/"))}
					</span>
					<LineStats
						insertions={change.insertions}
						deletions={change.deletions}
					/>
					<span
						className={cn(
							"shrink-0 text-[10px] font-semibold",
							STATUS_COLORS[change.status],
						)}
					>
						{change.status}
					</span>
				</div>
			))}
		</div>
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
				<span className="text-green-500">
					+<NumberTicker value={insertions} className="text-green-500" />
				</span>
			)}
			{deletions > 0 && (
				<span className="text-red-400">
					−<NumberTicker value={deletions} className="text-red-400" />
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
