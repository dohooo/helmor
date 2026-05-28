import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMaterialFileIcon } from "file-extension-icon-js";
import {
	Check,
	ChevronRight,
	Copy,
	Eye,
	FileCode,
	Plus,
	Search,
	X,
} from "lucide-react";
import {
	type MutableRefObject,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { ShortcutMap } from "@/features/shortcuts/types";
import type { ShortcutHandler } from "@/features/shortcuts/use-app-shortcuts";
import { useAppShortcuts } from "@/features/shortcuts/use-app-shortcuts";
import {
	type EditorSessionState,
	type EditorViewMode,
	getBaseName,
	type InspectorFileItem,
	isMarkdownPath,
} from "@/lib/editor-session";
import {
	helmorQueryKeys,
	workspaceChangesQueryOptions,
	workspaceFilesQueryOptions,
} from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { describeUnknownError } from "@/lib/workspace-helpers";

// Refined segmented-tab look: no tray, soft glassy pill on the active state.
// Hover only changes text color (no bg) — otherwise hover-on-inactive sits next
// to active-bg and the boundary blurs. Active is the ONLY trigger with a bg.
const SEGMENT_CLASS = [
	"h-5 gap-1 rounded-[5px] px-1.5 py-0 text-micro font-normal tracking-tight",
	"border-transparent bg-transparent text-muted-foreground/70 shadow-none",
	"hover:bg-transparent hover:text-foreground",
	"data-active:bg-editor-tab-active data-active:text-foreground data-active:border-transparent data-active:shadow-none",
	"aria-selected:bg-editor-tab-active aria-selected:text-foreground aria-selected:border-transparent aria-selected:shadow-none",
	"dark:data-active:bg-editor-tab-active dark:data-active:border-transparent",
	"dark:aria-selected:bg-editor-tab-active dark:aria-selected:border-transparent",
	"[&_svg:not([class*='size-'])]:size-2.5",
].join(" ");

const EDITOR_CHROME_BACKGROUND_CLASS = "bg-editor-chrome";

type WorkspaceEditorSurfaceProps = {
	editorSession: EditorSessionState;
	editShortcut?: string | null;
	shortcutOverrides?: ShortcutMap;
	workspaceId?: string | null;
	workspaceRootPath?: string | null;
	onChangeSession: (session: EditorSessionState) => void;
	onExit: () => void;
	onError?: (description: string, title?: string) => void;
};

type SurfaceStatus =
	| { kind: "loading" }
	| { kind: "ready" }
	| { kind: "error"; message: string };

type MonacoRuntimeModule = typeof import("@/lib/monaco-runtime");
type FileController = Awaited<
	ReturnType<MonacoRuntimeModule["createFileEditor"]>
>;
type DiffController = Awaited<
	ReturnType<MonacoRuntimeModule["createDiffEditor"]>
>;

type EditorFileTab = {
	id: string;
	session: EditorSessionState;
};

function getEditorBreadcrumbSegments(
	path: string,
	workspaceRootPath?: string | null,
): string[] {
	const normalizedPath = normalizePath(path);
	const normalizedRoot = workspaceRootPath
		? normalizePath(workspaceRootPath)
		: "";
	const rootPrefix = normalizedRoot.endsWith("/")
		? normalizedRoot
		: `${normalizedRoot}/`;
	const relativePath =
		normalizedRoot && normalizedPath.startsWith(rootPrefix)
			? normalizedPath.slice(rootPrefix.length)
			: normalizedPath;
	const segments = relativePath.split("/").filter(Boolean);
	return segments.length > 0 ? segments : [relativePath || normalizedPath];
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

function getEditorTabId(session: EditorSessionState): string {
	return normalizePath(session.path);
}

function upsertEditorTab(
	tabs: EditorFileTab[],
	session: EditorSessionState,
): EditorFileTab[] {
	const id = getEditorTabId(session);
	const nextTab = { id, session };
	const existingIndex = tabs.findIndex((tab) => tab.id === id);
	if (existingIndex === -1) {
		return [...tabs, nextTab];
	}
	return tabs.map((tab, index) => (index === existingIndex ? nextTab : tab));
}

function EditorPathBreadcrumb({
	segments,
	fullPath,
}: {
	segments: string[];
	fullPath: string;
}) {
	const [copied, setCopied] = useState(false);
	const handleCopyPath = () => {
		if (!navigator.clipboard?.writeText) return;
		void navigator.clipboard.writeText(fullPath).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className="group/path flex min-w-0 items-center overflow-hidden text-ui font-medium tracking-normal">
			{segments.map((segment, index) => {
				return (
					<span
						key={`${segment}-${index}`}
						className="flex min-w-0 shrink items-center"
					>
						{index > 0 && (
							<ChevronRight
								aria-hidden="true"
								className="mx-1 size-3 shrink-0 text-muted-foreground/45"
								strokeWidth={1.9}
							/>
						)}
						{index === segments.length - 1 && (
							<img
								src={getMaterialFileIcon(segment)}
								alt=""
								className="mr-1 size-4 shrink-0"
							/>
						)}
						<span className="truncate text-muted-foreground">{segment}</span>
					</span>
				);
			})}
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label="Copy absolute path"
				onClick={handleCopyPath}
				className="pointer-events-none ml-1 size-5 shrink-0 rounded-sm text-muted-foreground/35 opacity-0 hover:bg-accent/50 hover:text-muted-foreground group-hover/path:pointer-events-auto group-hover/path:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
			>
				{copied ? (
					<Check className="size-3" strokeWidth={1.8} />
				) : (
					<Copy className="size-3" strokeWidth={1.8} />
				)}
			</Button>
		</div>
	);
}

function EditorShortcutHint({ hotkey }: { hotkey: string | null }) {
	if (!hotkey) return null;
	return (
		<span className="ml-0.5 inline-flex h-4 items-center rounded-[3px] bg-muted/60 px-1 text-micro font-medium leading-none text-muted-foreground/80">
			<InlineShortcutDisplay hotkey={hotkey} />
		</span>
	);
}

function EditorFileTabs({
	tabs,
	activeTabId,
	onSelectTab,
	onCloseTab,
	onOpenSearch,
}: {
	tabs: EditorFileTab[];
	activeTabId: string;
	onSelectTab: (tab: EditorFileTab) => void;
	onCloseTab: (tabId: string) => void;
	onOpenSearch: () => void;
}) {
	return (
		<div
			data-tauri-drag-region
			className="flex h-full min-w-0 flex-1 items-stretch overflow-hidden"
		>
			<div className="scrollbar-none h-full min-w-0 overflow-x-auto">
				<Tabs
					value={activeTabId}
					onValueChange={(value) => {
						const tab = tabs.find((candidate) => candidate.id === value);
						if (tab) onSelectTab(tab);
					}}
					className="h-full min-w-max gap-0"
				>
					<TabsList
						aria-label="Open files"
						className="inline-flex h-full w-max justify-start self-start bg-transparent p-0"
					>
						{tabs.map((tab) => {
							const active = tab.id === activeTabId;
							return (
								<TabsTrigger
									key={tab.id}
									value={tab.id}
									className={cn(
										"group/tab relative h-full w-auto min-w-[7rem] max-w-[14rem] shrink-0 flex-none justify-start gap-1.5 overflow-hidden rounded-none border-0 bg-transparent px-3 text-ui text-muted-foreground shadow-none data-active:bg-background data-active:text-foreground data-active:shadow-none aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-none dark:data-active:border-transparent dark:data-active:bg-background dark:aria-selected:border-transparent dark:aria-selected:bg-background",
										active ? "font-medium" : undefined,
									)}
								>
									<span className="tab-content-fade flex min-w-0 flex-1 items-center gap-1.5">
										<img
											src={getMaterialFileIcon(getBaseName(tab.session.path))}
											alt=""
											className="size-4 shrink-0"
										/>
										<span className="truncate">
											{getBaseName(tab.session.path)}
										</span>
										{tab.session.dirty ? (
											<span
												aria-label="Modified"
												className="size-1.5 shrink-0 rounded-full bg-muted-foreground/55"
											/>
										) : null}
									</span>
									<span className="pointer-events-none invisible absolute inset-y-0 right-0 flex items-center pr-1 group-hover/tab:pointer-events-auto group-hover/tab:visible">
										<span
											role="button"
											aria-label={`Close ${getBaseName(tab.session.path)}`}
											onPointerDown={(event) => {
												event.preventDefault();
												event.stopPropagation();
											}}
											onClick={(event) => {
												event.preventDefault();
												event.stopPropagation();
												onCloseTab(tab.id);
											}}
											className="flex cursor-interactive items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
										>
											<X className="size-3" strokeWidth={2} />
										</span>
									</span>
								</TabsTrigger>
							);
						})}
					</TabsList>
				</Tabs>
			</div>
			<button
				type="button"
				aria-label="Open file"
				onClick={onOpenSearch}
				className="ml-1 flex h-full w-6 shrink-0 cursor-interactive items-center justify-center self-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0"
			>
				<Plus className="size-3.5" strokeWidth={1.8} />
			</button>
		</div>
	);
}

function FileSearchOverlay({
	files,
	query,
	selectedIndex,
	loading,
	error,
	onQueryChange,
	onSelectedIndexChange,
	onOpen,
	onClose,
}: {
	files: InspectorFileItem[];
	query: string;
	selectedIndex: number;
	loading: boolean;
	error: string | null;
	onQueryChange: (value: string) => void;
	onSelectedIndexChange: (value: number) => void;
	onOpen: (file: InspectorFileItem) => void;
	onClose: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({
			block: "nearest",
		});
	}, [selectedIndex]);

	const statusText = loading
		? "Loading files"
		: error
			? error
			: files.length === 0
				? "No files found"
				: null;

	return (
		<div className="absolute inset-x-0 top-14 z-50 flex justify-center px-6">
			<div className="w-full max-w-xl overflow-hidden rounded-xl border border-border/70 bg-popover/95 shadow-2xl backdrop-blur-xl">
				<div className="flex h-12 items-center gap-3 border-b border-border/65 px-4">
					<Search className="size-4 shrink-0 text-muted-foreground" />
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => {
							onQueryChange(event.target.value);
							onSelectedIndexChange(0);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								onClose();
								return;
							}
							if (event.key === "ArrowDown") {
								event.preventDefault();
								onSelectedIndexChange(
									files.length === 0 ? 0 : (selectedIndex + 1) % files.length,
								);
								return;
							}
							if (event.key === "ArrowUp") {
								event.preventDefault();
								onSelectedIndexChange(
									files.length === 0
										? 0
										: (selectedIndex - 1 + files.length) % files.length,
								);
								return;
							}
							if (event.key === "Enter") {
								event.preventDefault();
								const file = files[selectedIndex];
								if (file) onOpen(file);
							}
						}}
						placeholder="Search files"
						className="h-full min-w-0 flex-1 bg-transparent text-body font-medium text-foreground outline-none placeholder:text-muted-foreground/55"
					/>
				</div>
				<div className="max-h-80 overflow-y-auto px-1.5 py-2 scroll-py-2">
					{statusText ? (
						<div className="px-3 py-8 text-center text-ui text-muted-foreground">
							{statusText}
						</div>
					) : (
						files.map((file, index) => (
							<button
								key={file.absolutePath}
								ref={index === selectedIndex ? selectedItemRef : undefined}
								type="button"
								onPointerMove={() => onSelectedIndexChange(index)}
								onClick={() => onOpen(file)}
								className={cn(
									"flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-ui",
									index === selectedIndex
										? "bg-accent text-accent-foreground"
										: "text-muted-foreground",
								)}
							>
								<img
									src={getMaterialFileIcon(file.name)}
									alt=""
									className="size-4 shrink-0"
								/>
								<span className="min-w-0 flex-1 truncate font-medium">
									{file.path}
								</span>
							</button>
						))
					)}
				</div>
			</div>
		</div>
	);
}

export function WorkspaceEditorSurface({
	editorSession,
	editShortcut = null,
	shortcutOverrides = {},
	workspaceId = null,
	workspaceRootPath,
	onChangeSession,
	onExit,
	onError,
}: WorkspaceEditorSurfaceProps) {
	const queryClient = useQueryClient();
	const surfaceRef = useRef<HTMLElement>(null);
	const editorHostRef = useRef<HTMLDivElement>(null);
	const fileControllerRef = useRef<FileController | null>(null);
	const diffControllerRef = useRef<DiffController | null>(null);
	const changeSubscriptionRef = useRef<{ dispose(): void } | null>(null);
	const latestSessionRef = useRef(editorSession);
	const onChangeSessionRef = useRef(onChangeSession);
	const onErrorRef = useRef(onError);
	const applyValueRef = useRef(false);
	const buildRequestIdRef = useRef(0);
	const [fileTabs, setFileTabs] = useState<EditorFileTab[]>(() => [
		{ id: getEditorTabId(editorSession), session: editorSession },
	]);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
	const [surfaceStatus, setSurfaceStatus] = useState<SurfaceStatus>({
		kind: "ready",
	});
	latestSessionRef.current = editorSession;
	onChangeSessionRef.current = publishSessionChange;
	onErrorRef.current = onError;

	const canRenderFile =
		editorSession.kind === "file" &&
		editorSession.originalText !== undefined &&
		editorSession.modifiedText !== undefined;
	const canRenderDiff =
		editorSession.kind === "diff" &&
		editorSession.originalText !== undefined &&
		editorSession.modifiedText !== undefined;
	const closeLabel =
		editorSession.kind === "diff" ? "Close diff view" : "Close editor view";
	const isMarkdown = isMarkdownPath(editorSession.path);
	const viewMode: EditorViewMode = isMarkdown
		? (editorSession.viewMode ?? "source")
		: "source";
	const showPreview = isMarkdown && viewMode === "preview";
	const canEditFromDiff =
		editorSession.kind === "diff" && editorSession.fileStatus !== "D";
	const canReturnToDiff =
		editorSession.kind === "file" &&
		editorSession.fileStatus !== undefined &&
		editorSession.fileStatus !== "D";
	const breadcrumbSegments = useMemo(
		() => getEditorBreadcrumbSegments(editorSession.path, workspaceRootPath),
		[editorSession.path, workspaceRootPath],
	);
	const previewContent = useMemo(() => {
		if (!showPreview) return "";
		return editorSession.modifiedText ?? editorSession.originalText ?? "";
	}, [showPreview, editorSession.modifiedText, editorSession.originalText]);
	const activeTabId = getEditorTabId(editorSession);
	const workspaceFilesQuery = useQuery({
		...workspaceFilesQueryOptions(workspaceRootPath ?? ""),
		enabled: searchOpen && Boolean(workspaceRootPath),
	});
	const filteredWorkspaceFiles = useMemo(() => {
		const files = workspaceFilesQuery.data ?? [];
		const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const filtered =
			terms.length === 0
				? files
				: files.filter((file) => {
						const path = file.path.toLowerCase();
						const name = file.name.toLowerCase();
						return terms.every(
							(term) => path.includes(term) || name.includes(term),
						);
					});

		return filtered.slice(0, 40);
	}, [searchQuery, workspaceFilesQuery.data]);

	function publishSessionChange(next: EditorSessionState) {
		setFileTabs((tabs) => upsertEditorTab(tabs, next));
		onChangeSession(next);
	}

	const openFileSearch = useCallback(() => {
		setSearchOpen(true);
		setSelectedSearchIndex(0);
	}, []);

	const closeTabById = useCallback(
		(tabId: string) => {
			const index = fileTabs.findIndex((tab) => tab.id === tabId);
			if (index === -1) return;
			if (fileTabs.length === 1) {
				onExit();
				return;
			}

			const nextTabs = fileTabs.filter((tab) => tab.id !== tabId);
			setFileTabs(nextTabs);
			if (tabId === activeTabId) {
				const nextTab = fileTabs[index + 1] ?? fileTabs[index - 1];
				if (nextTab) onChangeSession(nextTab.session);
			}
		},
		[activeTabId, fileTabs, onChangeSession, onExit],
	);

	const editorShortcutHandlers = useMemo<ShortcutHandler[]>(
		() => [
			{
				id: "editor.new",
				callback: openFileSearch,
			},
			{
				id: "editor.close",
				callback: () => closeTabById(getEditorTabId(latestSessionRef.current)),
			},
		],
		[closeTabById, openFileSearch],
	);

	useAppShortcuts({
		overrides: shortcutOverrides,
		handlers: editorShortcutHandlers,
	});

	useEffect(() => {
		setFileTabs((tabs) => upsertEditorTab(tabs, editorSession));
	}, [editorSession]);

	useEffect(() => {
		if (selectedSearchIndex >= filteredWorkspaceFiles.length) {
			setSelectedSearchIndex(0);
		}
	}, [filteredWorkspaceFiles.length, selectedSearchIndex]);

	useEffect(() => {
		if (
			(editorSession.kind === "file" && canRenderFile) ||
			(editorSession.kind === "diff" && canRenderDiff)
		) {
			return;
		}

		let cancelled = false;

		void (async () => {
			try {
				const api = await import("@/lib/api");
				const isDiff = editorSession.kind === "diff";
				const status = editorSession.fileStatus ?? "M";
				const origRef = editorSession.originalRef ?? "HEAD";

				// Fetch original side (from git ref)
				const originalPromise =
					isDiff && status !== "A" && workspaceRootPath
						? api.readFileAtRef(workspaceRootPath, editorSession.path, origRef)
						: Promise.resolve(null);

				// Fetch modified side (from disk or git ref)
				const modifiedPromise = editorSession.modifiedRef
					? workspaceRootPath
						? api.readFileAtRef(
								workspaceRootPath,
								editorSession.path,
								editorSession.modifiedRef,
							)
						: Promise.resolve(null)
					: status !== "D"
						? api.readEditorFile(editorSession.path).then((r) => r.content)
						: Promise.resolve(null);

				const [original, modified] = await Promise.all([
					originalPromise,
					modifiedPromise,
				]);

				if (cancelled) {
					return;
				}

				onChangeSessionRef.current({
					...editorSession,
					originalText:
						editorSession.originalText ??
						(isDiff ? (original ?? "") : (modified ?? "")),
					modifiedText: editorSession.modifiedText ?? modified ?? "",
					dirty: Boolean(editorSession.dirty),
				});
			} catch (error) {
				if (cancelled) {
					return;
				}

				const message = describeUnknownError(
					error,
					"Unable to load the selected file.",
				);
				setSurfaceStatus({ kind: "error", message });
				onErrorRef.current?.(message, "File open failed");
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [canRenderDiff, canRenderFile, editorSession, workspaceRootPath]);

	// Reclaim focus on mount AND on every file/kind switch — without it, a click
	// in the changes list (a tabIndex={0} row outside any focus-scope) leaves
	// keyboard focus on that row and editor-scoped shortcuts (Cmd+E/T/W) stop
	// firing. The `surface.contains(activeElement)` guard means we only step in
	// when focus is currently outside the editor — typing inside Monaco isn't
	// disturbed by tab switches.
	useEffect(() => {
		const surface = surfaceRef.current;
		if (!surface) return;
		if (surface.contains(document.activeElement)) return;
		const controller = fileControllerRef.current ?? diffControllerRef.current;
		if (controller) {
			controller.focus();
			return;
		}
		surface.focus({ preventScroll: true });
	}, [editorSession.path, editorSession.kind]);

	// Dispose editors on unmount (separate from the switching effect so the
	// fast-path can skip cleanup without leaking on unmount).
	useEffect(() => {
		return () => {
			disposeControllers({
				fileControllerRef,
				diffControllerRef,
				changeSubscriptionRef,
			});
		};
	}, []);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			if (searchOpen) {
				setSearchOpen(false);
				return;
			}
			onExit();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onExit, searchOpen]);

	// ⌘⇧V toggles markdown preview, mirroring VS Code's "Markdown: Toggle Preview".
	useEffect(() => {
		if (!isMarkdown) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			const isToggle =
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey &&
				event.key.toLowerCase() === "v";
			if (!isToggle) return;
			event.preventDefault();
			const next: EditorViewMode =
				viewMode === "preview" ? "source" : "preview";
			onChangeSessionRef.current({
				...latestSessionRef.current,
				viewMode: next,
			});
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isMarkdown, viewMode]);

	// useLayoutEffect: run model swap BEFORE browser paint to avoid flicker.
	// The fast path returns NO cleanup — we keep the editor instance alive across
	// path changes. Only the slow path (first creation / kind change) disposes.
	useLayoutEffect(() => {
		const host = editorHostRef.current;
		if (!host) {
			return;
		}

		// ── Fast path: reuse existing file editor on path change ──
		// Runs even when content isn't loaded yet — switchFile uses Monaco model cache.
		if (editorSession.kind === "file" && fileControllerRef.current) {
			const content = editorSession.modifiedText ?? editorSession.originalText;
			const switched = fileControllerRef.current.switchFile(
				editorSession.path,
				content,
				editorSession.line,
				editorSession.column,
			);

			if (switched) {
				// Sync parent state from cached model when content wasn't in state yet
				if (content === undefined) {
					const cachedContent = fileControllerRef.current.getValue();
					onChangeSessionRef.current({
						...latestSessionRef.current,
						originalText: cachedContent,
						modifiedText: cachedContent,
						dirty: false,
					});
				}

				changeSubscriptionRef.current?.dispose();
				changeSubscriptionRef.current = null;
				changeSubscriptionRef.current =
					fileControllerRef.current.onDidChangeModelContent((value) => {
						if (applyValueRef.current) {
							return;
						}
						const latest = latestSessionRef.current;
						const nextDirty = value !== (latest.originalText ?? "");
						if (
							value === latest.modifiedText &&
							nextDirty === Boolean(latest.dirty)
						) {
							return;
						}
						onChangeSessionRef.current({
							...latest,
							kind: "file",
							modifiedText: value,
							dirty: nextDirty,
						});
					});
			}

			// No cleanup — editor stays alive. Unmount cleanup handles disposal.
			return;
		}

		// Note: there is intentionally no diff fast path. setValue() on an
		// existing diff model defers diff computation to Monaco's worker, so
		// the first paint after a path switch shows the new text without
		// hunk decorations / line gutters — visually "incomplete first
		// frame, complete second frame". createDiffEditor() computes the
		// diff synchronously during construction, so the slow path (dispose
		// + recreate) is what gives the "one-shot, fully-rendered first
		// frame" behavior users expect. Since the Monaco runtime is cached
		// after first use, the dispose+create round-trip resolves inside
		// the same microtask burst (no blank paint), so we pay no visual
		// cost for keeping diff on the slow path.

		// ── Guard: need content for initial editor creation ──
		if (!canRenderFile && !canRenderDiff) {
			return;
		}

		// ── Slow path: first render or kind change ──
		const requestId = buildRequestIdRef.current + 1;
		buildRequestIdRef.current = requestId;
		let disposed = false;

		disposeControllers({
			fileControllerRef,
			diffControllerRef,
			changeSubscriptionRef,
		});
		host.replaceChildren();

		if (editorSession.kind === "file") {
			void (async () => {
				try {
					const { createFileEditor } = await import("@/lib/monaco-runtime");
					const controller = await createFileEditor({
						container: host,
						path: editorSession.path,
						content:
							editorSession.modifiedText ?? editorSession.originalText ?? "",
						line: editorSession.line,
						column: editorSession.column,
					});

					if (disposed || requestId !== buildRequestIdRef.current) {
						controller.dispose();
						return;
					}

					fileControllerRef.current = controller;
					changeSubscriptionRef.current = controller.onDidChangeModelContent(
						(value) => {
							if (applyValueRef.current) {
								return;
							}
							const latest = latestSessionRef.current;
							const nextDirty = value !== (latest.originalText ?? "");
							if (
								value === latest.modifiedText &&
								nextDirty === Boolean(latest.dirty)
							) {
								return;
							}
							onChangeSessionRef.current({
								...latest,
								kind: "file",
								modifiedText: value,
								dirty: nextDirty,
							});
						},
					);
					// Slow path drops focus during the dispose→create cycle. If
					// the user hasn't moved focus elsewhere while we were async,
					// reclaim it so editor-scoped shortcuts work without a click.
					const surface = surfaceRef.current;
					if (surface && !surface.contains(document.activeElement)) {
						controller.focus();
					}
					setSurfaceStatus({ kind: "ready" });
				} catch (error) {
					const message = describeUnknownError(
						error,
						"Unable to start the editor.",
					);
					setSurfaceStatus({ kind: "error", message });
					onErrorRef.current?.(message, "Editor startup failed");
				}
			})();
		} else {
			void (async () => {
				try {
					const { createDiffEditor } = await import("@/lib/monaco-runtime");
					const controller = await createDiffEditor({
						container: host,
						path: editorSession.path,
						originalText: editorSession.originalText ?? "",
						modifiedText: editorSession.modifiedText ?? "",
						inline: Boolean(editorSession.inline),
					});

					if (disposed || requestId !== buildRequestIdRef.current) {
						controller.dispose();
						return;
					}

					diffControllerRef.current = controller;
					const surface = surfaceRef.current;
					if (surface && !surface.contains(document.activeElement)) {
						controller.focus();
					}
					setSurfaceStatus({ kind: "ready" });
				} catch (error) {
					const message = describeUnknownError(
						error,
						"Unable to start the review surface.",
					);
					setSurfaceStatus({ kind: "error", message });
					onErrorRef.current?.(message, "Review surface failed");
				}
			})();
		}

		return () => {
			// Only guard against stale async completions — do NOT dispose the
			// editor here.  The slow path's entry block already calls
			// disposeControllers before creating a new editor (handles kind
			// changes), and the separate unmount effect handles final cleanup.
			disposed = true;
		};
	}, [canRenderDiff, canRenderFile, editorSession.kind, editorSession.path]);

	useEffect(() => {
		if (
			editorSession.kind !== "file" ||
			!fileControllerRef.current ||
			editorSession.modifiedText === undefined
		) {
			return;
		}

		applyValueRef.current = true;
		try {
			fileControllerRef.current.setValue(editorSession.modifiedText);
		} finally {
			applyValueRef.current = false;
		}
	}, [editorSession.kind, editorSession.modifiedText]);

	useEffect(() => {
		if (editorSession.kind !== "file" || !fileControllerRef.current) {
			return;
		}

		fileControllerRef.current.revealPosition(
			editorSession.line,
			editorSession.column,
		);
	}, [editorSession.column, editorSession.kind, editorSession.line]);

	useEffect(() => {
		if (
			editorSession.kind !== "diff" ||
			!diffControllerRef.current ||
			editorSession.originalText === undefined ||
			editorSession.modifiedText === undefined
		) {
			return;
		}

		diffControllerRef.current.setTexts({
			originalText: editorSession.originalText,
			modifiedText: editorSession.modifiedText,
			inline: Boolean(editorSession.inline),
		});
	}, [
		editorSession.inline,
		editorSession.kind,
		editorSession.modifiedText,
		editorSession.originalText,
	]);

	const handleViewModeChange = (next: string) => {
		if (next !== "source" && next !== "preview") return;
		if (next === viewMode) return;
		publishSessionChange({
			...editorSession,
			viewMode: next,
		});
	};

	const handleEnterEditMode = () => {
		if (editorSession.kind !== "diff") return;
		publishSessionChange({
			kind: "file",
			path: editorSession.path,
			line: editorSession.line,
			column: editorSession.column,
			dirty: false,
			inline: editorSession.inline,
			fileStatus: editorSession.fileStatus,
			originalRef: editorSession.originalRef,
			modifiedRef: editorSession.modifiedRef,
			diffOriginalText: editorSession.originalText,
			diffModifiedText: editorSession.modifiedText,
			viewMode: isMarkdown ? "source" : undefined,
		});
	};

	const handleReturnToDiffMode = () => {
		if (editorSession.kind !== "file") return;
		publishSessionChange({
			kind: "diff",
			path: editorSession.path,
			line: editorSession.line,
			column: editorSession.column,
			dirty: editorSession.dirty,
			inline: editorSession.inline,
			fileStatus: editorSession.fileStatus,
			originalRef: editorSession.originalRef,
			modifiedRef: editorSession.modifiedRef,
			originalText: editorSession.diffOriginalText,
			modifiedText: editorSession.dirty
				? editorSession.modifiedText
				: editorSession.diffModifiedText,
			diffOriginalText: editorSession.diffOriginalText,
			diffModifiedText: editorSession.diffModifiedText,
			viewMode: isMarkdown ? "source" : undefined,
		});
	};

	const handleOpenSearchFile = async (file: InspectorFileItem) => {
		try {
			const existingTab = fileTabs.find(
				(tab) =>
					normalizePath(tab.session.path) === normalizePath(file.absolutePath),
			);
			const changes = workspaceRootPath
				? await queryClient
						.fetchQuery(
							workspaceChangesQueryOptions(workspaceRootPath, workspaceId),
						)
						.catch(() => null)
				: null;
			const changedFile = changes?.find(
				(item) =>
					normalizePath(item.absolutePath) === normalizePath(file.absolutePath),
			);

			if (changedFile) {
				const nextSession: EditorSessionState =
					existingTab?.session.fileStatus !== undefined
						? existingTab.session
						: {
								kind: "diff",
								path: changedFile.absolutePath,
								fileStatus: changedFile.status,
							};
				publishSessionChange(nextSession);
				setSearchOpen(false);
				setSearchQuery("");
				setSelectedSearchIndex(0);
				return;
			}

			if (existingTab) {
				publishSessionChange(existingTab.session);
				setSearchOpen(false);
				setSearchQuery("");
				setSelectedSearchIndex(0);
				return;
			}

			const api = await import("@/lib/api");
			const result = await api.readEditorFile(file.absolutePath);
			publishSessionChange({
				kind: "file",
				path: result.path,
				originalText: result.content,
				modifiedText: result.content,
				dirty: false,
				mtimeMs: result.mtimeMs,
				viewMode: isMarkdownPath(result.path) ? "source" : undefined,
			});
			setSearchOpen(false);
			setSearchQuery("");
			setSelectedSearchIndex(0);
		} catch (error) {
			const message = describeUnknownError(
				error,
				"Unable to open the selected file.",
			);
			onErrorRef.current?.(message, "File open failed");
		}
	};

	const handleSave = async () => {
		const latest = latestSessionRef.current;
		if (latest.kind !== "file" || latest.modifiedText === undefined) {
			return;
		}
		try {
			const api = await import("@/lib/api");
			const result = await api.writeEditorFile(
				latest.path,
				latest.modifiedText,
			);
			onChangeSessionRef.current({
				...latest,
				originalText: latest.modifiedText,
				dirty: false,
				mtimeMs: result.mtimeMs,
			});
			if (workspaceRootPath) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChanges(
						workspaceRootPath,
						workspaceId,
					),
				});
			}
		} catch (error) {
			const message = describeUnknownError(
				error,
				"Unable to save the selected file.",
			);
			onErrorRef.current?.(message, "Save failed");
		}
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const saveShortcut =
				(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
			if (!saveShortcut) return;
			if (latestSessionRef.current.kind !== "file") return;
			event.preventDefault();
			void handleSave();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	});

	return (
		<section
			ref={surfaceRef}
			aria-label="Workspace editor surface"
			data-focus-scope="editor"
			tabIndex={-1}
			className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground focus:outline-none"
		>
			<div
				className={cn("flex h-9 items-center", EDITOR_CHROME_BACKGROUND_CLASS)}
				data-tauri-drag-region
			>
				{/* Traffic-light inset. macOS: left; Windows / Linux: right. */}
				<TrafficLightSpacer side="left" width={86} />

				<div
					data-tauri-drag-region
					className="flex min-w-0 flex-1 items-center"
				>
					<EditorFileTabs
						tabs={fileTabs}
						activeTabId={activeTabId}
						onSelectTab={(tab) => publishSessionChange(tab.session)}
						onCloseTab={closeTabById}
						onOpenSearch={openFileSearch}
					/>
				</div>

				<div className="flex shrink-0 items-center gap-0 pr-2">
					{isMarkdown && (
						<Tabs
							value={viewMode}
							onValueChange={handleViewModeChange}
							aria-label="Markdown view mode"
						>
							{/* No tray: bg-transparent + p-0. Pill highlight only on the active trigger. */}
							<TabsList className="h-5 gap-0 bg-transparent p-0">
								<TabsTrigger value="source" className={SEGMENT_CLASS}>
									<FileCode strokeWidth={1.8} />
									Source
								</TabsTrigger>
								<TabsTrigger value="preview" className={SEGMENT_CLASS}>
									<Eye strokeWidth={1.8} />
									Preview
								</TabsTrigger>
							</TabsList>
						</Tabs>
					)}
					{canEditFromDiff && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={handleEnterEditMode}
							className="gap-1 px-1.5 text-muted-foreground hover:text-foreground"
						>
							<span>Edit</span>
							<EditorShortcutHint hotkey={editShortcut} />
						</Button>
					)}
					{canReturnToDiff && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={handleReturnToDiffMode}
							className="gap-1 px-1.5 text-muted-foreground hover:text-foreground"
						>
							<span>Diff</span>
							<EditorShortcutHint hotkey={editShortcut} />
						</Button>
					)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onExit}
						aria-label={closeLabel}
						className="gap-1 px-1.5 text-muted-foreground hover:text-foreground"
					>
						<span>Close</span>
						<EditorShortcutHint hotkey="Escape" />
					</Button>
				</div>
			</div>

			<div
				className={cn("flex h-8 items-center", EDITOR_CHROME_BACKGROUND_CLASS)}
				data-tauri-drag-region
			>
				<div className="min-w-0 flex-1 px-4">
					<EditorPathBreadcrumb
						segments={breadcrumbSegments}
						fullPath={editorSession.path}
					/>
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1 bg-background">
				{searchOpen && (
					<FileSearchOverlay
						files={filteredWorkspaceFiles}
						query={searchQuery}
						selectedIndex={selectedSearchIndex}
						loading={workspaceFilesQuery.isLoading}
						error={
							workspaceFilesQuery.isError
								? describeUnknownError(
										workspaceFilesQuery.error,
										"Unable to list workspace files.",
									)
								: null
						}
						onQueryChange={setSearchQuery}
						onSelectedIndexChange={setSelectedSearchIndex}
						onOpen={handleOpenSearchFile}
						onClose={() => setSearchOpen(false)}
					/>
				)}
				{/* Monaco host stays mounted in preview mode so model + dirty state survive toggling. */}
				<div
					ref={editorHostRef}
					aria-label="Editor canvas"
					className="h-full min-h-0 flex-1"
					aria-hidden={showPreview}
					style={showPreview ? { visibility: "hidden" } : undefined}
				/>

				{showPreview && (
					<div
						aria-label="Markdown preview"
						className="absolute inset-0 overflow-y-auto bg-background"
					>
						<div className="conversation-markdown mx-auto max-w-3xl break-words px-8 py-6 text-ui leading-6 text-foreground">
							<Suspense
								fallback={
									<pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground">
										{previewContent}
									</pre>
								}
							>
								<LazyStreamdown
									className="conversation-streamdown"
									mode="static"
								>
									{previewContent}
								</LazyStreamdown>
							</Suspense>
						</div>
					</div>
				)}

				{surfaceStatus.kind === "error" && (
					<div className="absolute inset-0 flex items-center justify-center bg-background">
						<SurfaceMessage message={surfaceStatus.message} />
					</div>
				)}
			</div>
		</section>
	);
}

function SurfaceMessage({ message }: { message: string }) {
	return <p className="text-ui leading-5 text-muted-foreground">{message}</p>;
}

function disposeControllers({
	fileControllerRef,
	diffControllerRef,
	changeSubscriptionRef,
}: {
	fileControllerRef: MutableRefObject<FileController | null>;
	diffControllerRef: MutableRefObject<DiffController | null>;
	changeSubscriptionRef: MutableRefObject<{ dispose(): void } | null>;
}) {
	changeSubscriptionRef.current?.dispose();
	changeSubscriptionRef.current = null;
	fileControllerRef.current?.dispose();
	fileControllerRef.current = null;
	diffControllerRef.current?.dispose();
	diffControllerRef.current = null;
}
