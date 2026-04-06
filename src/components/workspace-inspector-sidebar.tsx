import { MarkGithubIcon } from "@primer/octicons-react";
import {
	ArrowUpRightIcon,
	CheckIcon,
	ChevronDown,
	ChevronRightIcon,
	CircleIcon,
	FileIcon,
	FolderIcon,
	FolderOpenIcon,
	ListIcon,
	ListTreeIcon,
	TriangleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listWorkspaceChangesWithContent } from "@/lib/api";
import type { InspectorFileItem } from "@/lib/editor-session";
import { cn } from "@/lib/utils";
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
	const [changes, setChanges] = useState<InspectorFileItem[]>([]);
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

	useEffect(() => {
		let cancelled = false;

		if (!workspaceRootPath) {
			setChanges([]);
			return () => {
				cancelled = true;
			};
		}

		void listWorkspaceChangesWithContent(workspaceRootPath)
			.then(async (response) => {
				if (cancelled) return;
				setChanges(response.items);

				// Cache file contents so switches are instant (no IPC needed)
				if (response.prefetched.length > 0) {
					const { preWarmFileContents } = await import("@/lib/monaco-runtime");
					preWarmFileContents(response.prefetched);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setChanges([]);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [workspaceRootPath]);

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
				setChangesHeight(nextChanges);
				setActionsHeight(nextActions);
			} else {
				setActionsHeight(
					Math.max(
						MIN_SECTION_HEIGHT,
						resizeState.initialActionsHeight + deltaY,
					),
				);
			}
		};

		const handleMouseUp = () => {
			setResizeState(null);
		};

		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = "ns-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
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

			<div
				aria-label="Actions panel body"
				className={cn(
					"overflow-y-auto bg-app-base/[0.16] text-[11.5px]",
					expanded && "flex-1",
				)}
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
			</div>
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
}: {
	bodyHeight: number;
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
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

			<div
				aria-label="Changes panel body"
				className="overflow-y-auto bg-app-base/[0.16] font-mono text-[11.5px]"
				style={{ height: `${bodyHeight}px` }}
			>
				{changes.length > 0 ? (
					treeView ? (
						<ChangesTreeView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={onOpenEditorFile}
						/>
					) : (
						<ChangesFlatView
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={onOpenEditorFile}
						/>
					)
				) : (
					<div className="px-3 py-3 text-[11px] leading-5 text-app-muted">
						Select a workspace with a root path to open files here.
					</div>
				)}
			</div>
		</section>
	);
}

function ChangesTreeView({
	changes,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
}: {
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
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
}: {
	nodes: Map<string, ReturnType<typeof buildTree>>;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	depth: number;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
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
								{isOpen ? (
									<FolderOpenIcon
										className="size-3.5 shrink-0 text-blue-400/80"
										strokeWidth={1.5}
									/>
								) : (
									<FolderIcon
										className="size-3.5 shrink-0 text-blue-400/80"
										strokeWidth={1.5}
									/>
								)}
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
								/>
							)}
						</div>
					);
				}

				const selected = node.file?.absolutePath === activeEditorPath;

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
						<FileIcon
							className="size-3.5 shrink-0 text-app-muted"
							strokeWidth={1.5}
						/>
						<span className="truncate">{node.name}</span>
						{node.file && (
							<span
								className={cn(
									"ml-auto shrink-0 text-[10px] font-semibold",
									STATUS_COLORS[node.file.status],
								)}
							>
								{node.file.status}
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
}: {
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile: (path: string) => void;
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
					<FileIcon
						className="size-3.5 shrink-0 text-app-muted"
						strokeWidth={1.5}
					/>
					<span className="truncate">{change.name}</span>
					<span className="ml-auto shrink-0 truncate text-[10px] text-app-muted">
						{change.path.slice(0, change.path.lastIndexOf("/"))}
					</span>
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
