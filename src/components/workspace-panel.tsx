import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	AlertTriangle,
	ArrowDown,
	ArrowRight,
	Bot,
	Check,
	ChevronDown,
	Circle,
	CircleDot,
	Clock3,
	Copy,
	FilePlus,
	FileText,
	FolderSearch,
	GitBranch,
	Globe,
	History,
	Info,
	LoaderCircle,
	MessageSquareText,
	Pencil,
	Plus,
	RotateCcw,
	Search,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import {
	type ComponentType,
	createElement,
	lazy,
	memo,
	type ReactNode,
	Suspense,
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useStickToBottom } from "use-stick-to-bottom";
import {
	type CollapsedGroupPart,
	createSession,
	deleteSession,
	type ExtendedMessagePart,
	type FileMentionPart,
	hideSession,
	type ImagePart,
	listRemoteBranches,
	loadHiddenSessions,
	type MessagePart,
	type PromptSuggestionPart,
	prefetchWorkspaceRemoteRefs,
	renameSession,
	type SessionAttachmentRecord,
	type SystemNoticePart,
	type ThreadMessageLike,
	type TodoListPart,
	type ToolCallPart,
	unhideSession,
	updateIntendedTargetBranch,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { HelmorProfiler } from "@/lib/dev-react-profiler";
import { recordMessageRender } from "@/lib/dev-render-debug";
import { estimateThreadRowHeights } from "@/lib/message-layout-estimator";
import { measureSync } from "@/lib/perf-marks";
import { helmorQueryKeys } from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import { childrenStructurallyEqual } from "@/lib/structural-equality";
import { cn } from "@/lib/utils";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./ai/reasoning";
import { ClaudeIcon, OpenAIIcon } from "./icons";
import { ImagePreviewBadge } from "./image-preview";
import { BaseTooltip } from "./ui/base-tooltip";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type WorkspacePanelProps = {
	workspace: WorkspaceDetail | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	selectedProvider?: string | null;
	sessionPanes: Array<{
		sessionId: string;
		messages: ThreadMessageLike[];
		sending: boolean;
		hasLoaded: boolean;
		presentationState: "presented";
	}>;
	attachments?: SessionAttachmentRecord[];
	loadingWorkspace?: boolean;
	loadingSession?: boolean;
	refreshingWorkspace?: boolean;
	refreshingSession?: boolean;
	sending?: boolean;
	sendingSessionIds?: Set<string>;
	onSelectSession?: (sessionId: string) => void;
	onPrefetchSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	onSessionRenamed?: (sessionId: string, title: string) => void;
	onWorkspaceChanged?: () => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
};

type RenderedMessage = ThreadMessageLike;
type StreamdownMode = "static" | "streaming";

const LazyStreamdown = lazy(async () => {
	const [{ Streamdown }, { streamdownComponents }] = await Promise.all([
		import("streamdown"),
		import("./streamdown-components"),
	]);

	function StreamdownWithOverrides(
		props: React.ComponentProps<typeof Streamdown>,
	) {
		return (
			<Streamdown
				{...props}
				components={{ ...streamdownComponents, ...props.components }}
			/>
		);
	}

	return { default: StreamdownWithOverrides };
});

let hasPreloadedStreamdown = false;
const CHAT_LAYOUT_CACHE_VERSION = "chat-layout-v1";
const NON_VIRTUALIZED_THREAD_MESSAGE_LIMIT = 12;
const PROGRESSIVE_VIEWPORT_DEFAULT_HEIGHT = 900;
const PROGRESSIVE_VIEWPORT_HEADER_HEIGHT = 24;
const PROGRESSIVE_VIEWPORT_FOOTER_HEIGHT = 20;

type ThreadViewportSlot = ComponentType<Record<string, never>>;

function preloadStreamdown() {
	if (hasPreloadedStreamdown) return;
	hasPreloadedStreamdown = true;
	void import("streamdown");
	void import("./streamdown-components");
}

export const WorkspacePanel = memo(function WorkspacePanel({
	workspace,
	sessions,
	selectedSessionId,
	selectedProvider,
	sessionPanes,
	attachments: _attachments,
	loadingWorkspace = false,
	loadingSession = false,
	refreshingWorkspace: _refreshingWorkspace = false,
	refreshingSession: _refreshingSession = false,
	sending = false,
	sendingSessionIds,
	onSelectSession,
	onPrefetchSession,
	onSessionsChanged,
	onSessionRenamed,
	onWorkspaceChanged,
	headerActions,
	headerLeading,
}: WorkspacePanelProps) {
	const selectedSession =
		sessions.find((s) => s.id === selectedSessionId) ?? null;
	const activePane =
		sessionPanes.find((pane) => pane.presentationState === "presented") ??
		sessionPanes[0] ??
		null;

	useEffect(() => {
		if (typeof window === "undefined") return;

		const idleCallbackId =
			"requestIdleCallback" in window
				? window.requestIdleCallback(() => preloadStreamdown(), {
						timeout: 1200,
					})
				: null;
		const timeoutId =
			idleCallbackId === null
				? window.setTimeout(() => preloadStreamdown(), 180)
				: null;

		return () => {
			if (idleCallbackId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleCallbackId);
			}
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
			}
		};
	}, []);

	return (
		<HelmorProfiler id="WorkspacePanel">
			<div className="flex min-h-0 flex-1 flex-col bg-transparent">
				<WorkspacePanelHeader
					workspace={workspace}
					sessions={sessions}
					selectedSessionId={selectedSessionId}
					selectedProvider={selectedProvider}
					sending={sending}
					sendingSessionIds={sendingSessionIds}
					loadingWorkspace={loadingWorkspace}
					headerActions={headerActions}
					headerLeading={headerLeading}
					onSelectSession={onSelectSession}
					onPrefetchSession={onPrefetchSession}
					onSessionsChanged={onSessionsChanged}
					onSessionRenamed={onSessionRenamed}
					onWorkspaceChanged={onWorkspaceChanged}
				/>

				{/* --- Timeline --- */}
				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					{activePane?.hasLoaded ? (
						<ActiveThreadViewport
							hasSession={!!selectedSession}
							pane={activePane}
						/>
					) : loadingWorkspace || loadingSession ? (
						<ConversationColdPlaceholder />
					) : (
						<EmptyState hasSession={!!selectedSession} />
					)}
				</div>
			</div>
		</HelmorProfiler>
	);
});

// ---------------------------------------------------------------------------
// Memoized header
//
// The header is intentionally a SEPARATE memoed component so that streaming
// re-renders of <WorkspacePanel> (driven by the new sessionPanes / messages
// reference each tick) do NOT cascade into the branch picker, session tabs,
// new-session button, or history dropdown. Its props are only:
//   - stable react-query data (workspace, sessions)
//   - selection state that changes only on user navigation
//   - callback refs that the container memoizes via useCallback
// As long as none of those change, the header bails out via React.memo and
// every icon under it stops re-rendering during streaming.
// ---------------------------------------------------------------------------

type WorkspacePanelHeaderProps = {
	workspace: WorkspaceDetail | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	selectedProvider?: string | null;
	sending: boolean;
	sendingSessionIds?: Set<string>;
	loadingWorkspace: boolean;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
	onSelectSession?: (sessionId: string) => void;
	onPrefetchSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	onSessionRenamed?: (sessionId: string, title: string) => void;
	onWorkspaceChanged?: () => void;
};

const WorkspacePanelHeader = memo(function WorkspacePanelHeader({
	workspace,
	sessions,
	selectedSessionId,
	selectedProvider,
	sending,
	sendingSessionIds,
	loadingWorkspace,
	headerActions,
	headerLeading,
	onSelectSession,
	onPrefetchSession,
	onSessionsChanged,
	onSessionRenamed,
	onWorkspaceChanged,
}: WorkspacePanelHeaderProps) {
	const [showHistory, setShowHistory] = useState(false);
	const [hiddenSessions, setHiddenSessions] = useState<
		WorkspaceSessionSummary[]
	>([]);
	const pushToast = useWorkspaceToast();
	const queryClient = useQueryClient();
	const branchesQuery = useQuery({
		queryKey: ["remoteBranches", workspace?.id],
		queryFn: () => listRemoteBranches(workspace!.id),
		enabled: false, // only fetch on demand
		staleTime: 5 * 60 * 1000, // cache for 5 minutes
		gcTime: 10 * 60 * 1000,
	});
	const remoteBranches = branchesQuery.data ?? [];
	const loadingBranches = branchesQuery.isFetching;
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState("");

	const handleCreateSession = useCallback(async () => {
		if (!workspace) return;
		try {
			const result = await createSession(workspace.id);
			onSessionsChanged?.();
			onSelectSession?.(result.sessionId);
		} catch (error) {
			console.error("Failed to create session:", error);
		}
	}, [workspace, onSessionsChanged, onSelectSession]);

	const handleHideSession = useCallback(
		async (sessionId: string, e: React.MouseEvent) => {
			e.stopPropagation();
			await hideSession(sessionId);
			onSessionsChanged?.();
		},
		[onSessionsChanged],
	);

	const handleToggleHistory = useCallback(async () => {
		if (!showHistory && workspace) {
			const hidden = await loadHiddenSessions(workspace.id);
			setHiddenSessions(hidden);
		}
		setShowHistory((v) => !v);
	}, [showHistory, workspace]);

	const handleUnhide = useCallback(
		async (sessionId: string) => {
			await unhideSession(sessionId);
			setHiddenSessions((prev) => {
				const next = prev.filter((s) => s.id !== sessionId);
				if (next.length === 0) setShowHistory(false);
				return next;
			});
			onSessionsChanged?.();
			onSelectSession?.(sessionId);
		},
		[onSessionsChanged, onSelectSession],
	);

	const handleDelete = useCallback(
		async (sessionId: string) => {
			await deleteSession(sessionId);
			setHiddenSessions((prev) => {
				const next = prev.filter((s) => s.id !== sessionId);
				if (next.length === 0) setShowHistory(false);
				return next;
			});
			onSessionsChanged?.();
		},
		[onSessionsChanged],
	);

	const handleStartRename = useCallback(
		(session: WorkspaceSessionSummary, event: React.MouseEvent) => {
			event.stopPropagation();
			setEditingSessionId(session.id);
			setEditingTitle(displaySessionTitle(session));
		},
		[],
	);

	const handleCommitRename = useCallback(async () => {
		if (!editingSessionId) return;
		const trimmed = editingTitle.trim();
		if (trimmed) {
			await renameSession(editingSessionId, trimmed);
			onSessionRenamed?.(editingSessionId, trimmed);
		}
		setEditingSessionId(null);
		setEditingTitle("");
	}, [editingSessionId, editingTitle, onSessionRenamed]);

	const handleCancelRename = useCallback(() => {
		setEditingSessionId(null);
		setEditingTitle("");
	}, []);

	return (
		<header className="relative z-20">
			<div
				aria-label="Workspace header"
				className="flex h-9 items-center justify-between gap-3 px-[18px]"
				data-tauri-drag-region
			>
				<div className="flex min-w-0 items-center gap-2 text-[12.5px]">
					{headerLeading}
					<span className="inline-flex items-center gap-1 px-1 py-0.5 font-medium text-app-foreground">
						<GitBranch className="size-3.5 text-app-warm" strokeWidth={1.9} />
						<span className="truncate">{workspace?.branch ?? "No branch"}</span>
					</span>
					{workspace?.intendedTargetBranch ? (
						<>
							<ArrowRight
								className="size-3 shrink-0 text-app-muted"
								strokeWidth={1.8}
							/>
							{workspace.state === "archived" ? (
								<span className="px-1 py-0.5 font-medium text-app-foreground-soft">
									{workspace.intendedTargetBranch}
								</span>
							) : (
								<BranchPicker
									currentBranch={workspace.intendedTargetBranch ?? ""}
									branches={remoteBranches}
									loading={loadingBranches}
									onOpen={() => {
										// Phase 1: show whatever's already cached locally,
										// instantly.
										void branchesQuery.refetch();
										// Phase 2: kick off a background `git fetch --prune
										// origin` (rate-limited to once per 10s on the backend).
										// When it returns, refetch the local list so any new/
										// removed branches show up. Errors are silent — the
										// dropdown is still usable with the cached list.
										void prefetchWorkspaceRemoteRefs(workspace.id)
											.then((res) => {
												if (res.fetched) {
													void branchesQuery.refetch();
												}
											})
											.catch(() => {});
									}}
									onSelect={(branch: string) => {
										if (branch === workspace.intendedTargetBranch) return;
										// Optimistic update: flip the header label *immediately*
										// in the workspace-detail query cache so the user sees
										// instant feedback. The IPC runs in the background, and
										// on failure we roll back to the previous value.
										const detailKey = helmorQueryKeys.workspaceDetail(
											workspace.id,
										);
										const previousDetail =
											queryClient.getQueryData<WorkspaceDetail | null>(
												detailKey,
											);
										if (previousDetail) {
											queryClient.setQueryData<WorkspaceDetail | null>(
												detailKey,
												{
													...previousDetail,
													intendedTargetBranch: branch,
												},
											);
										}

										void updateIntendedTargetBranch(workspace.id, branch)
											.then(({ reset }) => {
												onWorkspaceChanged?.();
												if (reset) {
													pushToast(
														`Local branch reset to origin/${branch}`,
														`Switched to ${branch}`,
														"default",
													);
												} else {
													pushToast(
														`Target branch updated`,
														`Switched to ${branch}`,
														"default",
													);
												}
											})
											.catch((err: unknown) => {
												// Roll back the optimistic update so the header
												// stops lying.
												if (previousDetail) {
													queryClient.setQueryData<WorkspaceDetail | null>(
														detailKey,
														previousDetail,
													);
												}
												pushToast(
													err instanceof Error ? err.message : String(err),
													"Branch switch failed",
													"destructive",
												);
											});
									}}
								/>
							)}
						</>
					) : null}
					{workspace?.state === "archived" ? (
						<span className="px-1 py-0.5 font-medium text-app-muted">
							Archived
						</span>
					) : null}
				</div>
				{headerActions && (
					<div className="flex shrink-0 items-center gap-1">
						{headerActions}
					</div>
				)}
			</div>

			{/* --- Session tabs row --- */}
			<div className="flex items-center px-4 pb-1">
				<div className="scrollbar-none min-w-0 flex-1 overflow-x-auto">
					{loadingWorkspace ? (
						<div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-[12px] text-app-muted">
							<Clock3 className="size-3 animate-pulse" strokeWidth={1.8} />
							Loading
						</div>
					) : sessions.length > 0 ? (
						<Tabs
							value={selectedSessionId ?? sessions[0]?.id}
							onValueChange={(value) => {
								onSelectSession?.(value);
							}}
							className="min-w-max gap-0"
						>
							<TabsList
								aria-label="Sessions"
								className="inline-flex w-auto justify-start bg-app-sidebar"
							>
								{sessions.map((session) => {
									const selected = session.id === selectedSessionId;
									const isActive = sendingSessionIds
										? sendingSessionIds.has(session.id)
										: selected && sending;
									const hasUnread = session.unreadCount > 0;
									const isEditing = editingSessionId === session.id;

									return (
										<BaseTooltip
											key={session.id}
											side="bottom"
											content={<span>{displaySessionTitle(session)}</span>}
										>
											<TabsTrigger
												value={session.id}
												onMouseEnter={() => {
													onPrefetchSession?.(session.id);
												}}
												onFocus={() => {
													onPrefetchSession?.(session.id);
												}}
												className="group/tab relative w-[7rem] shrink-0 justify-start gap-1.5 overflow-hidden pr-5 text-app-foreground-soft data-[state=active]:text-app-foreground"
											>
												<SessionProviderIcon
													agentType={
														selected
															? (selectedProvider ?? session.agentType)
															: session.agentType
													}
													active={isActive}
												/>
												{isEditing ? (
													<input
														// Mounted only when entering edit mode, so autoFocus
														// fires exactly once instead of refocusing on every
														// parent re-render (e.g. during streaming).
														// biome-ignore lint/a11y/noAutofocus: contextual rename input
														autoFocus
														value={editingTitle}
														onChange={(event) =>
															setEditingTitle(event.target.value)
														}
														onKeyDown={(event) => {
															if (event.key === "Enter") {
																event.preventDefault();
																void handleCommitRename();
															} else if (event.key === "Escape") {
																handleCancelRename();
															}
														}}
														onBlur={() => void handleCommitRename()}
														onClick={(event) => event.stopPropagation()}
														className="w-20 truncate rounded border border-app-border bg-app-base px-1 py-0 text-[13px] font-medium text-app-foreground outline-none focus:border-app-border-strong"
													/>
												) : (
													<span
														className={cn(
															"truncate font-medium",
															hasUnread && !selected
																? "text-app-foreground"
																: undefined,
														)}
													>
														{displaySessionTitle(session)}
													</span>
												)}
												{hasUnread && !isEditing ? (
													<span
														aria-label="Unread session"
														className="size-1.5 shrink-0 rounded-full bg-app-progress"
													/>
												) : null}
												{!isEditing ? (
													<span className="pointer-events-none invisible absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-[10px] bg-gradient-to-r from-transparent via-muted via-[35%] to-muted pl-5 pr-1 group-hover/tab:pointer-events-auto group-hover/tab:visible group-data-[state=active]/tab:via-background group-data-[state=active]/tab:to-background">
														<span
															role="button"
															aria-label="Rename session"
															onClick={(event) =>
																handleStartRename(session, event)
															}
															className="flex items-center justify-center rounded-sm p-0.5 hover:bg-app-toolbar-hover"
														>
															<Pencil className="size-2.5" strokeWidth={2} />
														</span>
														<span
															role="button"
															aria-label="Close session"
															onClick={(event) =>
																handleHideSession(session.id, event)
															}
															className="flex items-center justify-center rounded-sm p-0.5 hover:bg-app-toolbar-hover"
														>
															<X className="size-2.5" strokeWidth={2} />
														</span>
													</span>
												) : null}
											</TabsTrigger>
										</BaseTooltip>
									);
								})}
							</TabsList>
						</Tabs>
					) : (
						<div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-[12px] text-app-muted">
							<AlertCircle className="size-3" strokeWidth={1.8} />
							No sessions
						</div>
					)}
				</div>

				{/* New session button */}
				<button
					type="button"
					aria-label="New session"
					onClick={handleCreateSession}
					className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground-soft"
				>
					<Plus className="size-3.5" strokeWidth={1.8} />
				</button>

				{/* History button — right end of tab bar */}
				<div className="relative ml-1 shrink-0">
					<button
						type="button"
						aria-label="Session history"
						onClick={handleToggleHistory}
						className={cn(
							"flex size-7 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground-soft",
							showHistory && "bg-app-toolbar-hover text-app-foreground-soft",
						)}
					>
						<History className="size-3.5" strokeWidth={1.8} />
					</button>

					{/* Dropdown menu */}
					{showHistory ? (
						<div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-app-border bg-app-sidebar py-1 shadow-lg">
							{hiddenSessions.length > 0 ? (
								hiddenSessions.map((session) => (
									<div
										key={session.id}
										className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-app-foreground-soft hover:bg-app-toolbar-hover"
									>
										<div className="flex min-w-0 items-center gap-1.5">
											<SessionProviderIcon
												agentType={session.agentType}
												active={false}
											/>
											<span className="truncate">
												{displaySessionTitle(session)}
											</span>
										</div>
										<div className="flex shrink-0 items-center gap-0.5">
											<button
												type="button"
												aria-label="Restore session"
												onClick={() => handleUnhide(session.id)}
												className="rounded-sm p-1 text-app-muted transition-colors hover:text-app-foreground-soft"
											>
												<RotateCcw className="size-3" strokeWidth={1.8} />
											</button>
											<button
												type="button"
												aria-label="Delete session permanently"
												onClick={() => handleDelete(session.id)}
												className="rounded-sm p-1 text-app-muted transition-colors hover:text-red-400"
											>
												<Trash2 className="size-3" strokeWidth={1.8} />
											</button>
										</div>
									</div>
								))
							) : (
								<div className="px-2.5 py-1.5 text-[11px] text-app-muted">
									No hidden sessions
								</div>
							)}
						</div>
					) : null}
				</div>
			</div>
		</header>
	);
});

function ActiveThreadViewport({
	hasSession,
	pane,
}: {
	hasSession: boolean;
	pane: {
		sessionId: string;
		messages: ThreadMessageLike[];
		sending: boolean;
		hasLoaded: boolean;
		presentationState: "presented";
	};
}) {
	const stackRef = useRef<HTMLDivElement | null>(null);
	const [widthBucket, setWidthBucket] = useState(0);
	const [paneWidth, setPaneWidth] = useState(0);

	useLayoutEffect(() => {
		if (
			typeof window === "undefined" ||
			typeof ResizeObserver === "undefined"
		) {
			return;
		}

		const stack = stackRef.current;
		if (!stack) {
			return;
		}

		const updateWidthBucket = () => {
			const width = stack.clientWidth;
			setPaneWidth(width);
			setWidthBucket(width > 0 ? Math.max(1, Math.round(width / 32)) : 0);
		};

		updateWidthBucket();
		const observer = new ResizeObserver(() => {
			updateWidthBucket();
		});
		observer.observe(stack);

		return () => {
			observer.disconnect();
		};
	}, []);

	return (
		<div
			ref={stackRef}
			className="relative flex min-h-0 flex-1 overflow-hidden"
		>
			<div className="relative z-10 flex min-h-0 flex-1">
				<ChatThread
					hasSession={hasSession}
					layoutCacheKey={getSessionLayoutCacheKey(pane.sessionId, widthBucket)}
					messages={pane.messages}
					paneWidth={paneWidth}
					sessionId={pane.sessionId}
					sending={pane.sending}
				/>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Stick-to-bottom powered thread
// ---------------------------------------------------------------------------

function ChatThread({
	layoutCacheKey,
	messages,
	hasSession,
	paneWidth,
	sessionId,
	sending,
}: {
	layoutCacheKey: string;
	messages: ThreadMessageLike[];
	hasSession: boolean;
	paneWidth: number;
	sessionId: string;
	sending: boolean;
}) {
	// Messages are already pipeline-rendered ThreadMessageLike[] from Rust.
	const threadMessages = messages;
	const { settings } = useSettings();
	const usePlainThread =
		threadMessages.length <= NON_VIRTUALIZED_THREAD_MESSAGE_LIMIT;
	const hasStreamingMessage = threadMessages.some(
		(message) => message.streaming === true,
	);
	const pinTailRows = sending || hasStreamingMessage;
	const scrollParentRef = useRef<HTMLElement | null>(null);
	// `resize: "instant"` is critical for multi-subagent streaming. When a
	// Task tool call is accumulating children, the content div grows on
	// every pipeline Full() emit. Without this option,
	// `use-stick-to-bottom` would kick off a spring animation on every
	// growth event — each new resize interrupts the in-flight animation,
	// leaving the scroll position oscillating mid-spring and causing a
	// visible flicker localized to the streaming row. `initial` stays
	// instant so landing on a thread doesn't smooth-scroll.
	const { contentRef, scrollRef, scrollToBottom, stopScroll, isAtBottom } =
		useStickToBottom({
			initial: "instant",
			resize: "instant",
		});
	const handleScrollRef = useCallback(
		(element: HTMLElement | null) => {
			scrollParentRef.current = element;
			scrollRef(element);
		},
		[scrollRef],
	);
	const previousSendingRef = useRef(sending);
	const sendingJustStarted = sending && !previousSendingRef.current;

	useEffect(() => {
		previousSendingRef.current = sending;
	}, [sending]);

	useEffect(() => {
		if (sendingJustStarted) {
			void scrollToBottom("instant");
		}
	}, [sendingJustStarted, scrollToBottom]);

	useLayoutEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const scrollParent = scrollParentRef.current;
		if (!scrollParent) {
			return;
		}

		// Plain threads do not have ProgressiveConversationViewport's
		// layout-key reset path, so when ScrollArea stopped remounting on
		// session switch they kept the previous session's scroll position.
		// Keep the fix narrowly scoped to the plain-thread path: progressive
		// threads already compute their first paint from estimated total
		// height, and forcing an extra hide/reveal step here makes the
		// switch feel delayed.
		if (usePlainThread) {
			scrollParent.scrollTop = scrollParent.scrollHeight;
			return;
		}

		// Re-arm useStickToBottom on session switch. Once a user has scrolled up in
		// one session we intentionally call `stopScroll()`, which leaves the hook
		// escaped from its bottom lock. Without an explicit re-arm here that escaped
		// state carries into the next session because <ScrollArea> no longer
		// remounts, and progressive threads can miss their initial bottom-locked
		// resize handling.
		void scrollToBottom("instant");
	}, [scrollToBottom, sessionId, usePlainThread]);

	const itemContent = useCallback(
		(index: number, message: RenderedMessage) => (
			<MemoConversationMessage
				message={message}
				sessionId={sessionId}
				itemIndex={index}
			/>
		),
		[sessionId],
	);

	return (
		<HelmorProfiler id="ChatThread">
			<ConversationViewport
				data={threadMessages}
				fontSize={settings.fontSize}
				hasSession={hasSession}
				itemContent={itemContent}
				layoutCacheKey={layoutCacheKey}
				paneWidth={paneWidth}
				pinTailRows={pinTailRows}
				scrollRef={handleScrollRef}
				sessionId={sessionId}
				sending={sending}
				stopScroll={stopScroll}
				usePlainThread={usePlainThread}
				contentRef={contentRef}
			>
				<button
					type="button"
					onClick={() => {
						scrollToBottom();
					}}
					className={`conversation-scroll-button ${isAtBottom || sendingJustStarted ? "conversation-scroll-button-hidden" : ""}`}
					aria-label="Scroll to latest message"
				>
					<ArrowDown className="size-4" strokeWidth={2} />
				</button>
			</ConversationViewport>
		</HelmorProfiler>
	);
}

// ---------------------------------------------------------------------------
// Message components
// ---------------------------------------------------------------------------

function ConversationViewport({
	children,
	contentRef,
	data,
	fontSize,
	hasSession,
	itemContent,
	layoutCacheKey,
	paneWidth,
	pinTailRows,
	scrollRef,
	sessionId,
	sending,
	stopScroll,
	usePlainThread,
}: {
	children?: ReactNode;
	contentRef: React.RefCallback<HTMLElement>;
	data: RenderedMessage[];
	fontSize: number;
	hasSession: boolean;
	itemContent: (index: number, message: RenderedMessage) => ReactNode;
	layoutCacheKey: string;
	paneWidth: number;
	pinTailRows: boolean;
	scrollRef: React.RefCallback<HTMLElement>;
	sessionId: string;
	sending: boolean;
	stopScroll: () => void;
	usePlainThread: boolean;
}) {
	const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);

	const viewportRef = useCallback(
		(el: HTMLDivElement | null) => {
			setScrollParent(el);
			scrollRef(el);
		},
		[scrollRef],
	);

	const Header: ThreadViewportSlot = ConversationHeaderSpacer;
	const Footer: ThreadViewportSlot = sending
		? StreamingFooter
		: ConversationFooterSpacer;
	const EmptyPlaceholder: ThreadViewportSlot = () => (
		<div className="flex min-h-full flex-1 flex-col">
			<EmptyState hasSession={hasSession} />
		</div>
	);

	return (
		<div className="conversation-scroll-area relative min-h-0 flex-1 overflow-hidden">
			<div
				ref={viewportRef}
				className="conversation-scroll-viewport h-full w-full overflow-x-hidden overflow-y-auto"
			>
				{usePlainThread ? (
					<div ref={contentRef}>
						{Header ? createElement(Header) : null}
						{data.length === 0
							? EmptyPlaceholder
								? createElement(EmptyPlaceholder)
								: null
							: data.map((message, index) => (
									<ConversationRowShell
										key={message.id ?? `${message.role}:${index}`}
									>
										{itemContent(index, message)}
									</ConversationRowShell>
								))}
						{Footer ? createElement(Footer) : null}
					</div>
				) : (
					<ProgressiveConversationViewport
						data={data}
						emptyPlaceholder={EmptyPlaceholder}
						footer={Footer}
						fontSize={fontSize}
						header={Header}
						itemContent={itemContent}
						layoutCacheKey={layoutCacheKey}
						paneWidth={paneWidth}
						pinTailRows={pinTailRows}
						scrollParent={scrollParent}
						sessionId={sessionId}
						stopScroll={stopScroll}
						contentRef={contentRef}
					/>
				)}
			</div>
			{children}
		</div>
	);
}

function ProgressiveConversationViewport({
	contentRef,
	data,
	emptyPlaceholder: EmptyPlaceholder,
	footer: Footer,
	fontSize,
	header: Header,
	itemContent,
	layoutCacheKey,
	paneWidth,
	pinTailRows,
	scrollParent,
	sessionId,
	stopScroll,
}: {
	contentRef?: React.RefCallback<HTMLElement>;
	data: RenderedMessage[];
	emptyPlaceholder?: ThreadViewportSlot;
	footer?: ThreadViewportSlot;
	fontSize: number;
	header?: ThreadViewportSlot;
	itemContent: (index: number, message: RenderedMessage) => ReactNode;
	layoutCacheKey: string;
	paneWidth: number;
	pinTailRows: boolean;
	scrollParent: HTMLDivElement | null;
	sessionId: string;
	stopScroll: () => void;
}) {
	// Helmor only runs in the Tauri webview now; kept as a local constant so the
	// surrounding scroll/virtualization logic that branches on `isTauri` can
	// continue to read naturally. Follow-up cleanup can constant-fold the
	// `isTauri ? X : Y` call sites in a focused pass.
	const isTauri = true;
	// Scroll/viewport are intentionally tracked with two layers:
	//   1. `committedScrollTopRef` / `committedViewportRef` — the values React
	//      currently rendered with. Used to compute the visible window.
	//   2. `setCommittedScrollState` — only invoked when the scroll position
	//      has crossed half of our overscan buffer (or the viewport size has
	//      changed), so smooth in-window scrolling does NOT trigger any
	//      React renders or `visibleRows` recomputation.
	const [committedScrollState, setCommittedScrollState] = useState<{
		scrollTop: number;
		viewportHeight: number;
	}>({ scrollTop: 0, viewportHeight: 0 });
	const [measuredHeights, setMeasuredHeights] = useState<
		Record<string, number>
	>({});
	const initialScrollAppliedRef = useRef(false);
	const pendingScrollAdjustmentRef = useRef(0);
	const isUserScrollingRef = useRef(false);
	const scrollIdleTimerRef = useRef<ReturnType<
		typeof window.setTimeout
	> | null>(null);
	const deferredMeasuredHeightsRef = useRef<Record<string, number>>({});
	// Phase 2 / Goal #1.5 / iter 5:
	// Has the user actively scrolled UP at any point in this session? Set
	// the first time the user produces a real upward gesture (wheel up,
	// touch swipe down, ArrowUp/PageUp/Home keys). Used to gate
	// `pendingScrollAdjustmentRef` so height-correction "snap-back" only
	// happens while the user is intent on staying pinned to the bottom
	// (initial mount or freshly switched session). Once the user scrolls
	// up to view history, height corrections to rows in the overscan
	// buffer NO LONGER push the scroll position back down — eliminates
	// the user-visible "scrollbar moves up then snaps back" jitter.
	// Reset on layoutCacheKey change so each session switch re-arms
	// the auto-bottom-pin behaviour.
	const hasUserScrolledRef = useRef(false);

	// Reset transient viewport state synchronously when the layout key (i.e.
	// the active session) changes. We used to rely on `<ScrollArea
	// key={sessionId}>` to throw this state away on every switch via a
	// remount, but the remount also re-rendered every visible row. The "set
	// state during render to reset on prop change" pattern lets React discard
	// the in-progress render and immediately retry with fresh state, so a
	// single render replaces the previous render → useEffect → 2x setState →
	// extra render chain.
	const [lastLayoutCacheKey, setLastLayoutCacheKey] = useState(layoutCacheKey);
	if (lastLayoutCacheKey !== layoutCacheKey) {
		setLastLayoutCacheKey(layoutCacheKey);
		setCommittedScrollState({ scrollTop: 0, viewportHeight: 0 });
		setMeasuredHeights({});
		initialScrollAppliedRef.current = false;
		hasUserScrolledRef.current = false;
		isUserScrollingRef.current = false;
		deferredMeasuredHeightsRef.current = {};
		if (scrollIdleTimerRef.current !== null) {
			window.clearTimeout(scrollIdleTimerRef.current);
			scrollIdleTimerRef.current = null;
		}
	}
	const { scrollTop, viewportHeight } = committedScrollState;
	// Mirror of `measuredHeights` for synchronous reads inside the
	// `handleHeightChange` callback. The mirror is updated in a layout effect
	// (after commit) instead of during render to keep render pure under
	// Strict Mode / concurrent rendering.
	const measuredHeightsRef = useRef<Record<string, number>>(measuredHeights);
	useLayoutEffect(() => {
		measuredHeightsRef.current = measuredHeights;
	}, [measuredHeights]);

	const flushDeferredMeasuredHeights = useCallback(() => {
		const pending = deferredMeasuredHeightsRef.current;
		const entries = Object.entries(pending);
		if (entries.length === 0) {
			return;
		}
		deferredMeasuredHeightsRef.current = {};
		startTransition(() => {
			setMeasuredHeights((current) => ({
				...current,
				...Object.fromEntries(entries),
			}));
		});
	}, []);

	// Note: the post-commit reset that used to live here for layoutCacheKey
	// changes is now handled by the synchronous reset block above.

	useEffect(() => {
		if (!scrollParent) {
			return;
		}

		let rafId: number | null = null;
		const commitFromDom = () => {
			rafId = null;
			const nextScrollTop = scrollParent.scrollTop;
			const nextViewportHeight = scrollParent.clientHeight;
			setCommittedScrollState((current) => {
				const buffer =
					current.viewportHeight || PROGRESSIVE_VIEWPORT_DEFAULT_HEIGHT;
				const scrollDelta = Math.abs(nextScrollTop - current.scrollTop);
				const viewportDelta = Math.abs(
					nextViewportHeight - current.viewportHeight,
				);
				const isScrollingUp = nextScrollTop < current.scrollTop;
				const commitThreshold = isTauri
					? isScrollingUp
						? Math.max(24, Math.floor(buffer / 8))
						: Math.max(96, Math.floor(buffer / 3))
					: buffer / 2;
				// We render with `buffer = effectiveViewportHeight` of overscan
				// above and below the visible window, so any scroll movement
				// smaller than half the buffer is guaranteed to keep the same
				// rows in view. In that case we skip the state update entirely
				// to avoid re-running visibleRows / re-rendering rows.
				//
				// WKWebView does not like the large step size here: the visible
				// window advances in big batches, then newly-entering rows swap from
				// estimator height to measured height in one go, which shows up as the
				// user-visible “scroll a bit, then slightly snap back” artifact in
				// long archived sessions. Commit much more frequently in Tauri when the
				// user scrolls UP through history so the virtual window moves
				// continuously instead of in half-viewport jumps. When the user scrolls
				// back DOWN toward the bottom, however, overly-frequent commits just
				// cause realized rows to churn in small batches and feel “sticky”, so we
				// deliberately relax the threshold in that direction.
				if (scrollDelta < commitThreshold && viewportDelta < 8) {
					return current;
				}
				return {
					scrollTop: nextScrollTop,
					viewportHeight: nextViewportHeight,
				};
			});
		};

		const scheduleCommit = () => {
			if (rafId !== null) return;
			rafId = window.requestAnimationFrame(commitFromDom);
			isUserScrollingRef.current = true;
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
			}
			scrollIdleTimerRef.current = window.setTimeout(() => {
				isUserScrollingRef.current = false;
				scrollIdleTimerRef.current = null;
				flushDeferredMeasuredHeights();
			}, 120);
		};

		// Always commit the first observation so we know the actual viewport.
		setCommittedScrollState({
			scrollTop: scrollParent.scrollTop,
			viewportHeight: scrollParent.clientHeight,
		});
		scrollParent.addEventListener("scroll", scheduleCommit, {
			passive: true,
		});
		let observer: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(scheduleCommit);
			observer.observe(scrollParent);
		}

		return () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
			}
			if (scrollIdleTimerRef.current !== null) {
				window.clearTimeout(scrollIdleTimerRef.current);
				scrollIdleTimerRef.current = null;
			}
			scrollParent.removeEventListener("scroll", scheduleCommit);
			observer?.disconnect();
		};
	}, [flushDeferredMeasuredHeights, isTauri, scrollParent]);

	// Phase 2 / Goal #1.5 / iter 5:
	// Detect user-initiated upward scroll via wheel/keyboard/touch input
	// by listening on `window` with target filtering. Attaching wheel
	// listeners directly to a scroll container can prevent Chrome's fast
	// scroll path in some configurations (we saw a +20-30 % workspace-
	// switch perf regression with direct attachment, even with
	// `passive: true`). Listening on window keeps the scroll container
	// untouched from the browser's scroll fastpath perspective.
	useEffect(() => {
		if (!scrollParent || typeof window === "undefined") return;
		const STICK_TO_BOTTOM_ESCAPE_OFFSET_PX = 24;
		const escapeBottomLock = () => {
			hasUserScrolledRef.current = true;
			stopScroll();
		};
		const markScrolledAwayFromBottom = () => {
			const distanceFromBottom =
				scrollParent.scrollHeight -
				scrollParent.clientHeight -
				scrollParent.scrollTop;
			// `use-stick-to-bottom` keeps itself engaged while `scrollDifference <= 70`.
			// In WKWebView that threshold is too forgiving for our progressively
			// measured virtual list: once the user starts to leave the bottom, a stream
			// of small height corrections can keep re-pulling the viewport downward and
			// create the observed oscillation. Escape the hook earlier and explicitly.
			if (distanceFromBottom > STICK_TO_BOTTOM_ESCAPE_OFFSET_PX) {
				escapeBottomLock();
			}
		};
		const inScrollParent = (target: EventTarget | null) => {
			return (
				target instanceof Node &&
				(scrollParent === target || scrollParent.contains(target))
			);
		};
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < -2 && inScrollParent(event.target)) {
				escapeBottomLock();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				(event.key === "ArrowUp" ||
					event.key === "PageUp" ||
					event.key === "Home") &&
				inScrollParent(event.target)
			) {
				escapeBottomLock();
			}
		};
		const onTouchMove = (event: TouchEvent) => {
			if (inScrollParent(event.target)) {
				escapeBottomLock();
			}
		};
		window.addEventListener("wheel", onWheel as EventListener, {
			passive: true,
		});
		window.addEventListener("keydown", onKeyDown as unknown as EventListener, {
			passive: true,
		});
		window.addEventListener(
			"touchmove",
			onTouchMove as unknown as EventListener,
			{ passive: true },
		);
		scrollParent.addEventListener("scroll", markScrolledAwayFromBottom, {
			passive: true,
		});
		return () => {
			window.removeEventListener("wheel", onWheel as EventListener);
			window.removeEventListener(
				"keydown",
				onKeyDown as unknown as EventListener,
			);
			window.removeEventListener(
				"touchmove",
				onTouchMove as unknown as EventListener,
			);
			scrollParent.removeEventListener("scroll", markScrolledAwayFromBottom);
		};
	}, [scrollParent, stopScroll]);

	const estimatedHeights = useMemo(
		() => estimateThreadRowHeights(data, { fontSize, paneWidth }),
		[data, fontSize, paneWidth],
	);
	const rows = useMemo(
		() =>
			measureSync(
				"viewport:rows",
				() => {
					let top = 0;
					return data.map((message, index) => {
						const key = message.id ?? `${message.role}:${index}`;
						const estimatedHeight = estimatedHeights[index] ?? 72;
						const measuredHeight = measuredHeights[key];
						const height =
							measuredHeight !== undefined ? measuredHeight : estimatedHeight;
						const row = {
							height,
							index,
							key,
							message,
							top,
						};
						top += height;
						return row;
					});
				},
				{ count: data.length },
			),
		[data, estimatedHeights, measuredHeights],
	);
	const totalRowsHeight =
		rows.length > 0
			? rows[rows.length - 1]!.top + rows[rows.length - 1]!.height
			: 0;
	const headerHeight = Header ? PROGRESSIVE_VIEWPORT_HEADER_HEIGHT : 0;
	const footerHeight = Footer ? PROGRESSIVE_VIEWPORT_FOOTER_HEIGHT : 0;
	const effectiveViewportHeight =
		viewportHeight > 0 ? viewportHeight : PROGRESSIVE_VIEWPORT_DEFAULT_HEIGHT;
	const effectiveScrollTop =
		(scrollParent && initialScrollAppliedRef.current
			? scrollTop
			: Math.max(0, headerHeight + totalRowsHeight - effectiveViewportHeight)) -
		headerHeight;
	const buffer = effectiveViewportHeight;
	const windowTop = Math.max(0, effectiveScrollTop - buffer);
	const windowBottom = effectiveScrollTop + effectiveViewportHeight + buffer;
	const distanceFromBottom = Math.max(
		0,
		totalRowsHeight - (effectiveScrollTop + effectiveViewportHeight),
	);
	const tauriStableBottomZoneHeight = effectiveViewportHeight * 4;
	const tauriStableBottomTailHeight = effectiveViewportHeight * 6;
	const visibleRows = useMemo(
		() =>
			measureSync(
				"viewport:visible-rows",
				() => {
					if (isTauri && distanceFromBottom <= tauriStableBottomZoneHeight) {
						const tailWindowTop = Math.max(
							0,
							totalRowsHeight - tauriStableBottomTailHeight,
						);
						return rows.filter((row) => row.top + row.height >= tailWindowTop);
					}

					const inWindow = rows.filter((row) => {
						const rowBottom = row.top + row.height;
						return rowBottom >= windowTop && row.top <= windowBottom;
					});
					if (!pinTailRows || rows.length === 0) {
						return inWindow;
					}

					// `rows` is already index-ordered, so the tail (last 2 rows) sits
					// at indices [rows.length - 2, rows.length - 1]. We avoid the
					// previous `Map(...).sort(...)` (O(n log n) on every stream tick)
					// by appending only the tail rows that are not already at the
					// end of `inWindow`.
					const tailStartIndex = Math.max(0, rows.length - 2);
					const lastVisibleIndex =
						inWindow.length > 0 ? inWindow[inWindow.length - 1]!.index : -1;
					if (lastVisibleIndex >= rows.length - 1) {
						return inWindow;
					}
					const result = inWindow.slice();
					const appendStart = Math.max(tailStartIndex, lastVisibleIndex + 1);
					for (let i = appendStart; i < rows.length; i += 1) {
						result.push(rows[i]!);
					}
					return result;
				},
				{ totalRows: rows.length },
			),
		[
			distanceFromBottom,
			effectiveViewportHeight,
			isTauri,
			pinTailRows,
			rows,
			totalRowsHeight,
			windowBottom,
			windowTop,
		],
	);
	const totalContentHeight = headerHeight + totalRowsHeight + footerHeight;
	// Mirror of `rows` for synchronous reads inside `handleHeightChange`,
	// updated in a layout effect rather than during render.
	const rowsRef = useRef(rows);
	useLayoutEffect(() => {
		rowsRef.current = rows;
	}, [rows]);

	useLayoutEffect(() => {
		if (!scrollParent || initialScrollAppliedRef.current) {
			return;
		}

		// Phase 2 / Goal #3b / iter 1:
		// Read clientHeight ONCE and reuse. The previous implementation read
		// it twice: once to compute targetScrollTop and again inside the
		// setCommittedScrollState object literal. Between the two reads we
		// write `scrollTop = targetScrollTop`, which invalidates the layout
		// cache — so the second read becomes a NEW forced layout flush on
		// top of the first. Caching the value eliminates the second flush.
		const clientHeight = scrollParent.clientHeight;
		const targetScrollTop = Math.max(0, totalContentHeight - clientHeight);
		scrollParent.scrollTop = targetScrollTop;
		setCommittedScrollState({
			scrollTop: targetScrollTop,
			viewportHeight: clientHeight,
		});
		initialScrollAppliedRef.current = true;
	}, [scrollParent, totalContentHeight]);

	useLayoutEffect(() => {
		if (!scrollParent || pendingScrollAdjustmentRef.current === 0) {
			return;
		}

		// Phase 2 / Goal #1.5 / iter 5:
		// `pendingScrollAdjustment` was originally written to compensate for
		// height corrections to rows above the viewport, so visible content
		// stayed put as estimator → measured deltas applied. The problem:
		// when the user has scrolled UP to view history, those same height
		// corrections (firing for newly-mounted rows in the overscan buffer
		// above the visible window) snap the scroll position back DOWN —
		// the user-visible "scrollbar moves up then snaps back" jitter
		// captured in the Phase 1.5 jitter detector.
		//
		// Fix: only apply the accumulated adjustment if the user has NOT
		// actively scrolled away from the bottom in this session. Once the
		// user has scrolled up, accumulated adjustments are discarded —
		// visible content may shift slightly as out-of-view rows resize, but
		// the user's chosen scroll position is preserved.
		if (!hasUserScrolledRef.current) {
			scrollParent.scrollTop += pendingScrollAdjustmentRef.current;
		}
		pendingScrollAdjustmentRef.current = 0;
	}, [rows, scrollParent]);

	const handleHeightChange = useCallback(
		(rowKey: string, nextHeight: number) => {
			const roundedHeight = Math.max(24, Math.ceil(nextHeight));
			const row = rowsRef.current.find((entry) => entry.key === rowKey);
			if (!row) {
				return;
			}

			const previousHeight = measuredHeightsRef.current[rowKey] ?? row.height;
			if (Math.abs(previousHeight - roundedHeight) < 2) {
				return;
			}

			// WKWebView makes row-height corrections visible when they land during an
			// active upward scroll: the viewport keeps moving, but rows above and
			// inside the realized window get recomputed mid-gesture, which shows up as
			// periodic “mini snap-backs”. Keep the newest measured heights buffered
			// while the user is actively scrolling through history, then flush them
			// once scroll has been idle for a short moment.
			if (isTauri && hasUserScrolledRef.current && isUserScrollingRef.current) {
				deferredMeasuredHeightsRef.current[rowKey] = roundedHeight;
				return;
			}

			if (scrollParent && row.top + headerHeight < scrollParent.scrollTop) {
				pendingScrollAdjustmentRef.current += roundedHeight - previousHeight;
			}
			startTransition(() => {
				setMeasuredHeights((current) => ({
					...current,
					[rowKey]: roundedHeight,
				}));
			});
		},
		[headerHeight, isTauri, scrollParent],
	);

	if (data.length === 0) {
		return (
			<div ref={contentRef}>
				{Header ? createElement(Header) : null}
				{EmptyPlaceholder ? createElement(EmptyPlaceholder) : null}
				{Footer ? createElement(Footer) : null}
			</div>
		);
	}

	return (
		<div ref={contentRef} style={{ minHeight: totalContentHeight }}>
			{Header ? createElement(Header) : null}
			<div
				aria-label={`Conversation rows for session ${sessionId}`}
				style={{ height: totalRowsHeight, position: "relative" }}
			>
				{visibleRows.map((row) => (
					<MeasuredConversationRow
						key={row.key}
						disableContentVisibility={isTauri}
						onHeightChange={handleHeightChange}
						rowKey={row.key}
						top={row.top}
						estimatedHeight={row.height}
					>
						{itemContent(row.index, row.message)}
					</MeasuredConversationRow>
				))}
			</div>
			{Footer ? createElement(Footer) : null}
		</div>
	);
}

function MeasuredConversationRow({
	children,
	disableContentVisibility,
	estimatedHeight,
	onHeightChange,
	rowKey,
	top,
}: {
	children: ReactNode;
	disableContentVisibility: boolean;
	estimatedHeight: number;
	onHeightChange: (rowKey: string, nextHeight: number) => void;
	rowKey: string;
	top: number;
}) {
	const rowRef = useRef<HTMLDivElement | null>(null);

	useLayoutEffect(() => {
		const node = rowRef.current;
		if (!node) {
			return;
		}

		// Phase 2 / Goal #1 / iter 1 (variant A — re-applied after Goal #1.5):
		// Mount-time sync read keeps the initial snap-to-bottom correct. The
		// RO callback uses borderBoxSize to avoid the per-fire forced reflow
		// that dominated the Phase 1 trace.
		onHeightChange(rowKey, node.offsetHeight);

		if (typeof ResizeObserver === "undefined") {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const box = entry.borderBoxSize?.[0];
				const height = box ? box.blockSize : entry.contentRect.height;
				if (height < 1) continue;
				onHeightChange(rowKey, height);
			}
		});
		observer.observe(node);
		return () => {
			observer.disconnect();
		};
	}, [onHeightChange, rowKey]);

	// Phase 2 / Goal #3a / iter 3:
	// Per-row contain-intrinsic-size based on the estimator's predicted
	// height, not a static 100px placeholder. Static 100px caused CLS=0.37
	// because the browser laid out offscreen rows as 100px tall and then
	// shifted everything when the real content took ~280 px.
	const intrinsicSize = `auto ${Math.max(24, Math.round(estimatedHeight))}px`;
	return (
		<div
			ref={rowRef}
			style={{
				...(disableContentVisibility
					? conversationRowIsolationStyle
					: measuredRowIsolationStyle),
				containIntrinsicSize: intrinsicSize,
				left: 0,
				position: "absolute",
				right: 0,
				top,
			}}
			className="flow-root px-5 pb-1.5"
		>
			{children}
		</div>
	);
}

// Dynamic-height collapsibles inside a message row can trigger a broad repaint
// in Chromium when the row shrinks. Isolating paint to the row keeps adjacent
// messages from flashing during close transitions.
const conversationRowIsolationStyle = {
	contain: "paint",
	isolation: "isolate",
} as const;

// Phase 2 / Goal #3a / iter 2: re-attempt content-visibility: auto.
//
// Goal #3a iter 1 (transform: translateY) targeted the wrong cause — the
// 800-element style recalc on workspace switch is driven by INITIAL style
// computation of newly-mounted descendants, not by re-applying inline style
// on existing rows. The right tool is `content-visibility: auto`, which
// tells the browser to skip layout/paint/style recalc for off-screen
// descendants entirely.
//
// We previously tried this in Phase 2 Goal #1 iter 4 v2 and had to revert
// because the off-screen → on-screen transition caused apparent scroll
// jitter. That jitter came from pendingScrollAdjustment firing on the
// height-correction cascade as newly-mounted rows reported their
// measurements. Goal #1.5 iter 5 v7 now gates pendingScrollAdjustment by
// `hasUserScrolledRef` — once the user has done anything, height-correction
// snap-back is suppressed. The content-visibility jitter should now stay
// within the narrow pre-interaction window where auto-snap is exactly
// what the user wants.
//
// `contain-intrinsic-size: auto 100px` gives the browser a placeholder
// height while the row is offscreen. The `auto` keyword remembers the last
// rendered size, so once a row has been measured at least once, re-visits
// use the real size. First-time visits use the 100px fallback — matching
// this against the estimator avoids the large layout shifts we saw with a
// tiny placeholder in iter4 v1.
const measuredRowIsolationStyle = {
	...conversationRowIsolationStyle,
	contentVisibility: "auto",
	containIntrinsicSize: "auto 100px",
} as const;

// NOTE: this stays as a plain function (no React.memo) on purpose — its
// `children` prop is a fresh React element on every parent render, so
// memoing here would never bail out. The bail-out happens one level deeper
// inside `MemoConversationMessage` whose props (message reference,
// sessionId, itemIndex) are stable thanks to the structural sharing layer
// in workspace-panel-container.tsx.
function ConversationRowShell({ children }: { children: ReactNode }) {
	return (
		<div
			style={conversationRowIsolationStyle}
			className="flow-root px-5 pb-1.5"
		>
			{children}
		</div>
	);
}

function getSessionLayoutCacheKey(sessionId: string, widthBucket: number) {
	// Keep progressive viewport measurements stable across live appends and
	// streaming token growth. Width changes still reset the cache.
	return [CHAT_LAYOUT_CACHE_VERSION, sessionId, String(widthBucket)].join(":");
}

function ConversationColdPlaceholder() {
	return <div className="flex min-h-0 flex-1" aria-hidden="true" />;
}

function ConversationHeaderSpacer() {
	return <div className="h-6 shrink-0" />;
}

function ConversationFooterSpacer() {
	return <div className="h-5 shrink-0" />;
}

function StreamingFooter() {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		const start = Date.now();
		const id = window.setInterval(() => {
			setElapsed(Math.floor((Date.now() - start) / 1000));
		}, 1000);
		return () => window.clearInterval(id);
	}, []);

	const display =
		elapsed < 60
			? `${elapsed}s`
			: `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toString().padStart(2, "0")}s`;

	return (
		<div className="flex items-center gap-1.5 px-5 py-3 text-[12px] tabular-nums text-app-muted">
			<span className="flex gap-[2px]">
				<span className="inline-block size-[3px] animate-bounce rounded-full bg-app-muted [animation-delay:0ms]" />
				<span className="inline-block size-[3px] animate-bounce rounded-full bg-app-muted [animation-delay:150ms]" />
				<span className="inline-block size-[3px] animate-bounce rounded-full bg-app-muted [animation-delay:300ms]" />
			</span>
			{display}
		</div>
	);
}

function ConversationMessage({
	message,
	sessionId,
	itemIndex,
}: {
	message: RenderedMessage;
	sessionId: string;
	itemIndex: number;
}) {
	const messageKey = message.id ?? `${message.role}:${itemIndex}`;
	useEffect(() => {
		recordMessageRender(sessionId, messageKey);
	});

	// Only the actual streaming partial carries `streaming: true` (set by
	// the accumulator's __streaming flag).  Completed intermediate messages
	// with `stream:` prefix IDs are NOT streaming — they should render static.
	const streaming = message.role === "assistant" && message.streaming === true;

	if (message.role === "user") {
		return <ChatUserMessage message={message} />;
	}

	if (message.role === "assistant") {
		return <ChatAssistantMessage message={message} streaming={streaming} />;
	}

	return <ChatSystemMessage message={message} />;
}

const MemoConversationMessage = memo(ConversationMessage, (prev, next) => {
	return (
		prev.message === next.message &&
		prev.sessionId === next.sessionId &&
		prev.itemIndex === next.itemIndex
	);
});

function ChatUserMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];
	const { settings } = useSettings();

	// Group consecutive non-text parts (FileMention) with their neighboring
	// text into a single paragraph so the badges flow inline with the text.
	// Each text segment still goes through `UserText` so legacy `@/abs/path`
	// references in old DB rows continue to render via the regex fallback.
	return (
		<div
			data-message-id={message.id}
			data-message-role="user"
			className="flex min-w-0 justify-end"
		>
			<div
				className="max-w-[75%] overflow-hidden rounded-md bg-app-foreground/[0.03] px-3 py-2 leading-7 text-app-foreground"
				style={{ fontSize: `${settings.fontSize}px` }}
			>
				<p className="whitespace-pre-wrap break-words">
					{parts.map((part, idx) => {
						if (isTextPart(part)) {
							return <UserTextInline key={idx} text={part.text} />;
						}
						if (isFileMentionPart(part)) {
							return <FileBadgeInline key={idx} path={part.path} />;
						}
						return null;
					})}
				</p>
			</div>
		</div>
	);
}

function ChatAssistantMessage({
	message,
	streaming,
}: {
	message: RenderedMessage;
	streaming: boolean;
}) {
	const parts = message.content as ExtendedMessagePart[];
	const { settings } = useSettings();

	return (
		<div
			data-message-id={message.id}
			data-message-role="assistant"
			className="flex min-w-0 max-w-full flex-col gap-1"
		>
			{parts.map((part, idx) => {
				if (isTextPart(part)) {
					return (
						<AssistantText
							key={`text:${idx}`}
							text={part.text}
							streaming={streaming}
						/>
					);
				}
				if (isReasoningPart(part)) {
					return (
						<Reasoning
							key={`reasoning:${idx}`}
							isStreaming={part.streaming === true}
						>
							<ReasoningTrigger />
							<ReasoningContent fontSize={settings.fontSize}>
								{part.text}
							</ReasoningContent>
						</Reasoning>
					);
				}
				if (isCollapsedGroupPart(part)) {
					return (
						<CollapsedToolGroup
							key={`group-${part.tools[0]?.toolCallId ?? idx}`}
							group={part}
						/>
					);
				}
				if (isToolCallPart(part)) {
					return (
						<AssistantToolCall
							key={`tc:${part.toolCallId ?? `${part.toolName}:${idx}`}`}
							toolName={part.toolName}
							args={part.args}
							result={part.result}
							isError={(part as ToolCallPart).isError}
							toolUseResult={(part as ToolCallPart).toolUseResult}
							streamingStatus={(part as ToolCallPart).streamingStatus}
							childParts={(part as ToolCallPart).children}
						/>
					);
				}
				if (isTodoListPart(part)) {
					return <TodoList key={`todo:${idx}`} part={part} />;
				}
				if (isImagePart(part)) {
					return <ImageBlock key={`img:${idx}`} part={part} />;
				}
				return null;
			})}
		</div>
	);
}

function ChatSystemMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];

	return (
		<div
			data-message-id={message.id}
			data-message-role="system"
			className="group/sys flex min-w-0 items-center gap-1.5"
		>
			<div className="py-1 text-[11px] text-app-muted">
				{parts.map((part, idx) => {
					if (isSystemNoticePart(part)) {
						return <SystemNotice key={idx} part={part} />;
					}
					if (isPromptSuggestionPart(part)) {
						return <PromptSuggestion key={idx} part={part} />;
					}
					if (isTextPart(part)) {
						return <SystemText key={idx} text={part.text} />;
					}
					return null;
				})}
			</div>
			<CopyMessageButton />
		</div>
	);
}

function SystemNotice({ part }: { part: SystemNoticePart }) {
	const Icon =
		part.severity === "error"
			? AlertCircle
			: part.severity === "warning"
				? AlertTriangle
				: Info;
	const iconClass =
		part.severity === "error"
			? "text-app-negative"
			: part.severity === "warning"
				? "text-app-warning"
				: "text-app-info";
	return (
		<span className="inline-flex items-center gap-1">
			<Icon className={cn("size-3 shrink-0", iconClass)} strokeWidth={1.8} />
			<span>{part.label}</span>
			{part.body ? (
				<span className="ml-1 text-app-muted/70">— {part.body}</span>
			) : null}
		</span>
	);
}

function PromptSuggestion({ part }: { part: PromptSuggestionPart }) {
	return (
		<BaseTooltip content={<span>Use this prompt</span>}>
			<button
				type="button"
				className="my-1 inline-flex items-center gap-1 rounded-md border border-app-foreground/[0.08] bg-app-foreground/[0.02] px-2 py-1 text-[11px] text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.05]"
				onClick={() => {
					const composer = document.querySelector<HTMLTextAreaElement>(
						"textarea[data-composer-input]",
					);
					if (composer) {
						composer.value = part.text;
						composer.dispatchEvent(new Event("input", { bubbles: true }));
						composer.focus();
					}
				}}
			>
				<MessageSquareText className="size-3" strokeWidth={1.8} />
				<span className="max-w-[420px] truncate">{part.text}</span>
			</button>
		</BaseTooltip>
	);
}

function ImageBlock({ part }: { part: ImagePart }) {
	const src =
		part.source.kind === "url"
			? part.source.url
			: `data:${part.mediaType ?? "image/png"};base64,${part.source.data}`;
	return (
		<img
			src={src}
			alt=""
			className="my-2 max-h-[420px] max-w-full rounded-md border border-app-foreground/[0.06]"
		/>
	);
}

function TodoList({ part }: { part: TodoListPart }) {
	if (part.items.length === 0) return null;
	const completed = part.items.filter((i) => i.status === "completed").length;
	const total = part.items.length;
	return (
		<div className="my-1 flex flex-col gap-0.5 rounded-md border border-app-foreground/[0.06] bg-app-foreground/[0.02] px-3 py-2 text-[13px] leading-6 text-app-foreground-soft">
			<div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-app-muted">
				<MessageSquareText className="size-3" strokeWidth={1.8} />
				<span>
					Plan — {completed}/{total} done
				</span>
			</div>
			{part.items.map((todo, idx) => {
				const Icon =
					todo.status === "completed"
						? Check
						: todo.status === "in_progress"
							? CircleDot
							: Circle;
				const iconClass =
					todo.status === "completed"
						? "text-app-positive"
						: todo.status === "in_progress"
							? "text-app-progress"
							: "text-app-muted/60";
				const textClass =
					todo.status === "completed"
						? "text-app-muted line-through"
						: "text-app-foreground-soft";
				return (
					<div key={idx} className="flex items-center gap-1.5">
						<Icon
							className={cn("size-3 shrink-0", iconClass)}
							strokeWidth={1.8}
						/>
						<span className={textClass}>{todo.text}</span>
					</div>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Content part components
// ---------------------------------------------------------------------------

/** Regex matching @/path references (files with or without extension). */
const USER_FILE_RE = /@(\/\S+)(?=\s|$)/gi;

/** Image extensions for distinguishing images from other files. */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;

type UserContentSegment =
	| { type: "text"; value: string }
	| { type: "image"; value: string }
	| { type: "file"; value: string };

/**
 * Split user text into interleaved text, image, and file segments.
 *
 * Uses `text.matchAll()` instead of `regex.exec()` so the function does not
 * mutate `USER_FILE_RE.lastIndex`. The shared regex would otherwise race
 * across concurrent renders under React 19.
 */
function splitUserContent(text: string): UserContentSegment[] {
	const segments: UserContentSegment[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(USER_FILE_RE)) {
		const matchIndex = match.index ?? 0;
		const before = text.slice(lastIndex, matchIndex);
		if (before) segments.push({ type: "text", value: before });
		const filePath = match[1];
		segments.push({
			type: IMAGE_EXT_RE.test(filePath) ? "image" : "file",
			value: filePath,
		});
		lastIndex = matchIndex + match[0].length;
	}
	const after = text.slice(lastIndex);
	if (after) segments.push({ type: "text", value: after });
	return segments;
}

/**
 * Inline-only renderer for a TextPart inside a user message bubble. Returns
 * fragments (no `<p>` wrapper) so it can sit alongside FileMention badges
 * within the bubble's single paragraph. The regex split handles legacy
 * `@/abs/path` references in old DB rows that predate structured FileMention.
 */
const UserTextInline = memo(function UserTextInline({
	text,
}: {
	text: string;
}) {
	const segments = useMemo(() => splitUserContent(text), [text]);
	if (!segments.some((s) => s.type === "image" || s.type === "file")) {
		return <>{text}</>;
	}
	return (
		<>
			{segments.map((seg, idx) => {
				if (seg.type === "image") {
					return (
						<ImagePreviewBadge key={`${seg.value}-${idx}`} path={seg.value} />
					);
				}
				if (seg.type === "file") {
					return (
						<FileBadgeInline key={`${seg.value}-${idx}`} path={seg.value} />
					);
				}
				return <span key={idx}>{seg.value}</span>;
			})}
		</>
	);
});

/** Inline file badge for non-image files in chat messages. */
function FileBadgeInline({ path }: { path: string }) {
	const fileName = path.split("/").pop() ?? path;
	return (
		<span className="inline-flex items-center gap-1 rounded border border-app-border/60 text-[12px] mx-0.5 align-middle">
			<span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
				<FileText
					className="size-3 shrink-0 text-app-muted"
					strokeWidth={1.8}
				/>
				<span className="max-w-[200px] truncate text-app-foreground-soft">
					{fileName}
				</span>
			</span>
		</span>
	);
}

/** Stable animation config — avoids creating a new object on every render. */
const STREAMING_ANIMATED = {
	animation: "blurIn" as const,
	duration: 150,
	easing: "linear" as const,
	sep: "word" as const,
	stagger: 30,
};

const AssistantText = memo(function AssistantText({
	text,
	streaming,
}: {
	text: string;
	streaming: boolean;
}) {
	const mode: StreamdownMode = streaming ? "streaming" : "static";
	const { settings } = useSettings();

	return (
		<div
			className="conversation-markdown prose prose-sm max-w-none break-words leading-6 text-app-foreground prose-headings:my-0 prose-headings:text-app-foreground prose-p:my-0 prose-p:text-app-foreground prose-li:my-0 prose-li:text-app-foreground prose-strong:text-app-foreground prose-em:text-app-foreground prose-pre:my-0 prose-pre:border prose-pre:border-app-border prose-pre:bg-app-sidebar prose-pre:text-[12px] prose-pre:text-app-foreground prose-ul:my-0 prose-ol:my-0 prose-blockquote:my-0 prose-blockquote:border-app-border prose-blockquote:text-app-muted prose-table:my-0 prose-table:text-[11px] prose-table:text-app-foreground prose-th:border-app-border prose-th:text-app-foreground prose-td:border-app-border prose-td:text-app-foreground prose-tr:border-app-border prose-a:text-app-project prose-a:underline prose-a:decoration-app-project/30 prose-code:rounded prose-code:border prose-code:border-app-border/50 prose-code:bg-app-sidebar prose-code:px-1 prose-code:py-px prose-code:text-app-foreground-soft"
			style={{ fontSize: `${settings.fontSize}px` }}
		>
			<Suspense
				fallback={<AssistantTextFallback text={text} streaming={streaming} />}
			>
				<LazyStreamdown
					animated={streaming ? STREAMING_ANIMATED : false}
					caret={undefined}
					className="conversation-streamdown"
					isAnimating={streaming}
					mode={mode}
				>
					{text}
				</LazyStreamdown>
			</Suspense>
		</div>
	);
});

function AssistantTextFallback({
	text,
}: {
	text: string;
	streaming?: boolean;
}) {
	return (
		<div className="conversation-streamdown whitespace-pre-wrap break-words">
			{text}
		</div>
	);
}

type AssistantToolCallProps = {
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
	isError?: boolean;
	toolUseResult?: unknown;
	streamingStatus?: string;
	/** Compact mode — used by `AgentChildrenBlock`'s tail preview.
	 *  Strips the `<details>` wrapper and output panel so every row
	 *  renders as a single fixed-height summary line. This keeps the
	 *  preview container's height constant while a subagent streams
	 *  in, and prevents users from expanding individual rows inside
	 *  the preview (expand the whole subagent via "Show N more steps"
	 *  for the full trace). */
	compact?: boolean;
	/** Sub-agent work folded in by the Rust grouping pass. Only set
	 *  for `Task` / `Agent` tool calls. */
	childParts?: ExtendedMessagePart[];
};

/**
 * Memo comparator for `AssistantToolCall`. Extracted as a named
 * exported function so unit tests can pin the truth table directly,
 * not just the rendered DOM consequences. Direct tests guarantee the
 * comparator's bail-out vs invalidation decisions even when both
 * choices happen to produce the same DOM (e.g. content-identical-but-
 * different-reference `childParts`).
 */
export function assistantToolCallPropsEqual(
	prev: AssistantToolCallProps,
	next: AssistantToolCallProps,
): boolean {
	return (
		prev.toolName === next.toolName &&
		prev.streamingStatus === next.streamingStatus &&
		prev.result === next.result &&
		prev.isError === next.isError &&
		prev.toolUseResult === next.toolUseResult &&
		prev.compact === next.compact &&
		// `childParts` MUST be in the comparator. When a sibling subagent's
		// children grow, `shareMessages` rebuilds the parent message ref and
		// every tool-call inside it gets a fresh `children` array reference,
		// even unchanged ones. Without this check the memo bails out
		// (toolName/result/args all equal by value) and the rendered
		// subagent children would drift from the actual state.
		// `childrenStructurallyEqual` (not reference equality) lets
		// content-identical children bail out cheaply, so a busy sibling
		// doesn't cascade re-renders into every finished subagent's tree.
		childrenStructurallyEqual(prev.childParts, next.childParts) &&
		shallowArgsEqual(prev.args, next.args)
	);
}

/**
 * Exported for the component-level tests in
 * `workspace-panel.subagent.test.tsx` — those tests mount the
 * component and exercise the actual React memo bail-out path at
 * render time, which neither the Rust pipeline tests nor the
 * structural-equality unit tests can reach. Don't import this from
 * non-test code.
 */
export const AssistantToolCall = memo(function AssistantToolCall({
	toolName,
	args,
	result,
	isError,
	toolUseResult,
	streamingStatus,
	compact = false,
	childParts,
}: AssistantToolCallProps) {
	const info = getToolInfo(toolName, args);
	const isEdit = toolName === "Edit";
	const oldStr =
		isEdit && typeof args.old_string === "string" ? args.old_string : null;
	const newStr =
		isEdit && typeof args.new_string === "string" ? args.new_string : null;
	const hasDiff = oldStr != null || newStr != null;

	const resultStr = useMemo(
		() =>
			result != null
				? typeof result === "string"
					? result
					: JSON.stringify(result, null, 2)
				: null,
		[result],
	);
	const hasChildren = (childParts?.length ?? 0) > 0;
	// Tools whose payload lives in `args` (currently the synthetic
	// Prompt tool) feed `info.body` into the same `<pre>` panel
	// the `result`-based tools use, so the user gets identical
	// click-to-expand behavior with no per-tool render branches.
	// `info.body` overrides the result-derived text so a Prompt
	// tool — which has no `result` — still gets the expandable
	// affordance. `getToolInfo` is the gatekeeper here; only one
	// branch returns `body`, so there's no precedence ambiguity.
	const resultText = hasChildren ? null : (info.body ?? resultStr);
	const hasOutput = resultText != null && resultText.length > 5;
	const isLiveTool =
		streamingStatus === "pending" ||
		streamingStatus === "streaming_input" ||
		streamingStatus === "running";
	// Default expanded state is captured once at mount via useState init —
	// no effect needed because tool calls only progress forward (live tools
	// stay live until completion, completed tools never go back to live).
	// `isLiveTool || isOpen` in the open prop below still forces open while
	// streaming regardless of user toggles.
	const [isOpen, setIsOpen] = useState(isLiveTool);

	// Streaming status indicator
	const statusIndicator =
		streamingStatus === "pending" || streamingStatus === "streaming_input" ? (
			<LoaderCircle
				className="size-3 animate-spin text-app-muted/50"
				strokeWidth={2}
			/>
		) : streamingStatus === "running" ? (
			<LoaderCircle
				className="size-3 animate-spin text-app-progress"
				strokeWidth={2}
			/>
		) : streamingStatus === "error" ? (
			<AlertCircle className="size-3 text-app-negative" strokeWidth={2} />
		) : null;

	const toolLine = (
		<>
			<span className="shrink-0">{info.icon}</span>
			<span className="shrink-0 whitespace-nowrap font-medium">
				{info.action}
			</span>
			{info.file ? (
				hasDiff ? (
					<EditDiffTrigger
						file={info.file}
						diffAdd={info.diffAdd}
						diffDel={info.diffDel}
						oldStr={oldStr}
						newStr={newStr}
					/>
				) : (
					<span className="truncate text-app-foreground-soft">{info.file}</span>
				)
			) : null}
			{!hasDiff && (info.diffAdd != null || info.diffDel != null) ? (
				<span className="flex items-center gap-1 text-[11px]">
					{info.diffAdd != null ? (
						<span className="text-app-positive">+{info.diffAdd}</span>
					) : null}
					{info.diffDel != null ? (
						<span className="text-app-negative">-{info.diffDel}</span>
					) : null}
				</span>
			) : null}
			{info.command ? (
				// `min-w-0` overrides flex-item default `min-width: auto` so `truncate` can shrink the chip.
				<code className="inline-block min-w-0 truncate rounded bg-app-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-app-foreground-soft">
					{info.command}
				</code>
			) : info.detail ? (
				<span className="min-w-0 truncate text-app-muted/60">
					{info.detail}
				</span>
			) : null}
			{statusIndicator}
		</>
	);

	// Sub-agent children: show last N steps with "show more" toggle.
	// Pass primitive props (not the `toolLine` element) so the memo
	// on `AgentChildrenBlock` can actually bail out — a fresh React
	// element reference every render would defeat it and cascade
	// into re-rendering all the expanded children for every sibling
	// subagent's streaming tick. `AgentChildrenBlock` reconstructs
	// its own header from `toolName`/`toolArgs` internally.
	if (hasChildren && childParts) {
		return (
			<AgentChildrenBlock
				toolName={toolName}
				toolArgs={args}
				streamingStatus={streamingStatus}
				parts={childParts}
			/>
		);
	}

	// Compact render for tail previews inside AgentChildrenBlock.
	//
	// Key property: every compact row has IDENTICAL structure, so
	// the natural line height is the same regardless of tool type.
	// No `<code>` chip (which has padding + rounded + bg, adds
	// ~4px), no `EditDiffTrigger` button (has its own padding),
	// no diffAdd/diffDel badge with `text-[11px]`. Just three
	// flex children: icon, bolded action, and a truncated detail
	// span. Bash/Read/Grep/Edit/Glob all collapse to the same
	// visual shape, which is what keeps the preview container's
	// height stable as the tail window swaps one tool-call out
	// for another on every streaming tick — no CSS height lock,
	// no measured-max tracker, fully responsive to font size and
	// pane width.
	if (compact) {
		const detail = info.file ?? info.command ?? info.detail ?? null;
		return (
			<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-app-muted">
				<span className="shrink-0">{info.icon}</span>
				<span className="shrink-0 font-medium">{info.action}</span>
				{detail ? (
					<span className="truncate text-app-foreground-soft">{detail}</span>
				) : null}
			</div>
		);
	}

	return (
		<>
			<details
				className="group/out flex flex-col"
				onToggle={(event) => {
					setIsOpen(event.currentTarget.open);
				}}
				open={isLiveTool || isOpen}
			>
				<summary
					className={cn(
						"flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-app-muted [&::-webkit-details-marker]:hidden",
						hasOutput ? "cursor-pointer" : "cursor-default",
					)}
				>
					{toolLine}
					{hasOutput ? (
						<span className="shrink-0 cursor-pointer text-app-muted/40 hover:text-app-muted">
							<svg
								className="size-2.5 group-open/out:rotate-90"
								viewBox="0 0 12 12"
								fill="none"
							>
								<path
									d="M4.5 2.5L8.5 6L4.5 9.5"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</span>
					) : null}
				</summary>
				{hasOutput && (isLiveTool || isOpen) ? (
					<div className="max-h-[16rem] overflow-auto rounded-md bg-app-foreground/[0.02] text-[11px] leading-5">
						{info.fullCommand ? (
							<div className="border-b border-app-border/20 px-2 py-1.5">
								<span className="mr-1.5 text-app-project/60">$</span>
								<code className="font-mono text-app-foreground-soft">
									{info.fullCommand}
								</code>
							</div>
						) : null}
						<pre className="whitespace-pre-wrap break-words p-1.5 text-app-muted/70">
							{resultText!.slice(0, 2000)}
							{resultText!.length > 2000 ? "…" : ""}
						</pre>
					</div>
				) : null}
			</details>
			{isError === true ? (
				<ToolCallErrorRow result={result} toolUseResult={toolUseResult} />
			) : null}
		</>
	);
}, assistantToolCallPropsEqual);

function ToolCallErrorRow({
	result,
	toolUseResult,
}: {
	result: unknown;
	toolUseResult: unknown;
}) {
	const body = useMemo(
		() => extractToolErrorBody(toolUseResult, result),
		[toolUseResult, result],
	);
	if (!body) return null;
	return (
		<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-app-negative">
			<AlertCircle className="size-3.5 shrink-0" strokeWidth={1.8} />
			<span className="shrink-0 font-medium">Error</span>
			<code className="truncate rounded bg-app-negative/10 px-1.5 py-0.5 font-mono text-[11px]">
				{body}
			</code>
		</div>
	);
}

function extractToolErrorBody(
	toolUseResult: unknown,
	result: unknown,
): string | null {
	let prefix: string | null = null;
	let body: string | null = null;
	if (isObj(toolUseResult)) {
		const ec = toolUseResult.exit_code;
		if (typeof ec === "number" && ec !== 0) {
			prefix = `Exit code ${ec}`;
		}
		body =
			str(toolUseResult.stderr) ??
			str(toolUseResult.error) ??
			str(toolUseResult.stdout) ??
			null;
	} else if (typeof toolUseResult === "string") {
		body = toolUseResult.trim() || null;
	}
	if (!body && typeof result === "string") {
		body = result.trim() || null;
	}
	const combined = prefix && body ? `${prefix} ${body}` : (prefix ?? body);
	if (!combined) return null;
	// Strip leading "Error:" so we don't render "Error  Error: File not found".
	const cleaned = combined.replace(/^Error:\s*/i, "");
	const oneLine = cleaned.split("\n", 2)[0] ?? cleaned;
	return truncate(oneLine, 120);
}

/**
 * Shallow-compare tool call args. The accumulator either reuses the same args
 * object reference or only mutates a single field (streaming input), so a
 * shallow key/value === check is sufficient and avoids serializing large
 * Edit/Bash payloads on every render.
 */
function shallowArgsEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	if (a === b) return true;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

/** Number of recent children steps to show by default. */
const AGENT_PREVIEW_STEPS = 3;

type AgentChildrenBlockProps = {
	toolName: string;
	toolArgs: Record<string, unknown>;
	streamingStatus?: string;
	parts: ExtendedMessagePart[];
};

/**
 * Memo comparator for `AgentChildrenBlock`. Extracted as a named
 * exported function so unit tests can pin the bail-out contract
 * directly. The component-level subagent tests verify that re-renders
 * happen when content changes, but they can't isolate the
 * "structurally-equal-but-different-reference" bail-out path that
 * matters for performance — that path is what stops a busy sibling
 * subagent from cascading re-renders into every finished one.
 */
export function agentChildrenBlockPropsEqual(
	prev: AgentChildrenBlockProps,
	next: AgentChildrenBlockProps,
): boolean {
	return (
		prev.toolName === next.toolName &&
		prev.streamingStatus === next.streamingStatus &&
		// Content-aware compare so a parent message rebuild that produces
		// a fresh-but-content-identical `parts` reference doesn't cascade
		// into a useless re-render of all visible compact tool-calls.
		// Reference comparison alone is too strict — `shareMessages`
		// reuses message refs only at the message level, so when ANY
		// sibling subagent emits new children every other Task tool-call
		// gets a fresh `parts` array reference that needs the structural
		// shortcut.
		childrenStructurallyEqual(prev.parts, next.parts) &&
		shallowArgsEqual(prev.toolArgs, next.toolArgs)
	);
}

/**
 * Children block for Task/Agent tool calls. Rendered inside
 * `AssistantToolCall` whenever its `children` array is non-empty
 * (sub-agent work folded in by the Rust pipeline grouping pass).
 *
 * Memoized — accepts only primitive / stable-reference props so the
 * default shallow compare plus our custom `shallowArgsEqual` on
 * `toolArgs` can bail out cleanly. Crucially, the tool-line header is
 * NOT passed in as a React element (that would allocate a fresh
 * element ref on every parent render and defeat the memo); we
 * reconstruct it internally from `toolName`/`toolArgs` via
 * `getToolInfo`, which is cheap and deterministic.
 *
 * Bail-out matters here because the containing assistant message gets
 * a new reference whenever ANY sibling subagent's Task tool emits new
 * children — without the memo, that cascades into a full re-render of
 * every finished subagent's expanded children (dozens of Reasoning/
 * text/ToolCall subtrees), which shows up as flicker in the expanded
 * state of already-completed siblings.
 */
const AgentChildrenBlock = memo(function AgentChildrenBlock({
	toolName,
	toolArgs,
	streamingStatus,
	parts,
}: AgentChildrenBlockProps) {
	const [expanded, setExpanded] = useState(false);
	const streaming = !!streamingStatus;
	const info = getToolInfo(toolName, toolArgs);

	// Filter down to tool-call parts so text/reasoning/todo don't
	// drift into the tail preview.
	const toolCallParts = useMemo(
		() => parts.filter((p): p is ToolCallPart => p.type === "tool-call"),
		[parts],
	);
	const toolUseCount = toolCallParts.length;

	// Tail window — the preview always shows the LAST N tool-calls
	// so users see what the subagent is doing right now.
	const visibleParts: ExtendedMessagePart[] = expanded
		? parts
		: toolCallParts.slice(-AGENT_PREVIEW_STEPS);

	// `hasMore` is derived from the INVARIANT collapsed layout (the
	// visible count a user WOULD see if they collapsed right now),
	// not from `visibleParts`. Otherwise toggling into expanded mode
	// sets `hiddenCount = 0` → `hasMore = false` → the button
	// disappears → user has no way to collapse back.
	//
	// The toggle only surfaces once the tail window is actually
	// FULL — i.e. the subagent has emitted at least AGENT_PREVIEW_STEPS
	// tool-calls. Before that, 1 or 2 tool-calls render directly
	// with no "Show more" chrome, because there's nothing the user
	// couldn't see just by scrolling one line; a toggle on a
	// half-filled preview would be visual noise.
	const collapsedVisibleCount = Math.min(
		toolCallParts.length,
		AGENT_PREVIEW_STEPS,
	);
	const hiddenCount = parts.length - collapsedVisibleCount;
	const hasMore =
		toolCallParts.length >= AGENT_PREVIEW_STEPS && hiddenCount > 0;

	// Toggle button visibility:
	//   - `expanded` state: always allow collapsing (even mid-stream)
	//   - collapsed state: only allow expanding when not streaming
	//     (expanding mid-stream would show a flickery live trace)
	const canToggle = hasMore && (expanded || !streaming);

	return (
		<div className="flex flex-col">
			{/* Header line: icon + subagent_type + description + summary */}
			<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-app-muted">
				<span className="shrink-0">{info.icon}</span>
				<span className="font-medium">{info.action}</span>
				{info.detail ? (
					<span className="truncate text-app-muted/60">{info.detail}</span>
				) : null}
				{streaming ? (
					<LoaderCircle
						className="size-3 animate-spin text-app-progress"
						strokeWidth={2}
					/>
				) : null}
				<span className="shrink-0 text-[11px] text-app-muted/40">
					{toolUseCount > 0
						? `${toolUseCount} tool ${toolUseCount === 1 ? "use" : "uses"}`
						: `${parts.length} steps`}
				</span>
			</div>

			{/* Children steps */}
			<div className="ml-5 flex flex-col gap-0.5 border-l border-app-border/30 pl-3 pt-1">
				{/* "Show more" / "Collapse" toggle */}
				{canToggle ? (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						className="mb-0.5 flex items-center gap-1 text-[11px] text-app-muted/50 transition-colors hover:text-app-muted"
					>
						<ChevronDown
							className={cn(
								"size-3 transition-transform",
								expanded && "rotate-180",
							)}
							strokeWidth={1.5}
						/>
						{expanded
							? "Collapse"
							: `Show ${hiddenCount} more step${hiddenCount > 1 ? "s" : ""}`}
					</button>
				) : null}

				<div className="flex flex-col gap-0.5">
					{visibleParts.map((part, idx) => {
						if (isToolCallPart(part)) {
							// Stable key per logical tool invocation.
							return (
								<AssistantToolCall
									key={part.toolCallId ?? `tool-${idx}`}
									toolName={part.toolName ?? "unknown"}
									args={part.args ?? {}}
									result={part.result}
									isError={part.isError}
									toolUseResult={part.toolUseResult}
									compact={!expanded}
									childParts={part.children}
								/>
							);
						}
						// text / reasoning / todo-list only render in expanded mode.
						if (part.type === "text" && part.text) {
							return (
								<div
									key={`text-${idx}`}
									className="text-[13px] leading-6 text-app-foreground-soft"
								>
									{part.text.slice(0, 300)}
									{part.text.length > 300 ? "\u2026" : ""}
								</div>
							);
						}
						if (part.type === "reasoning" && part.text) {
							return (
								<Reasoning key={`reason-${idx}`}>
									<ReasoningTrigger />
									<ReasoningContent>{part.text}</ReasoningContent>
								</Reasoning>
							);
						}
						if (isTodoListPart(part)) {
							return <TodoList key={`todo-${idx}`} part={part} />;
						}
						return null;
					})}
				</div>
			</div>
		</div>
	);
}, agentChildrenBlockPropsEqual);

function CollapsedToolGroup({ group }: { group: CollapsedGroupPart }) {
	const [open, setOpen] = useState(group.active);
	// Re-open when a settled group becomes active again (new streaming tool appended).
	useEffect(() => {
		if (group.active) setOpen(true);
	}, [group.active]);

	const icon =
		group.category === "search" ? (
			<Search className="size-3.5 text-app-info" strokeWidth={1.8} />
		) : (
			<FileText className="size-3.5 text-app-info" strokeWidth={1.8} />
		);

	return (
		<details
			className="group/collapse flex flex-col"
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
			}}
			open={open}
		>
			<summary className="flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-app-muted [&::-webkit-details-marker]:hidden">
				<span className="shrink-0">{icon}</span>
				<span className="font-medium">{group.summary}</span>
				{group.active ? (
					<LoaderCircle
						className="size-3 animate-spin text-app-progress"
						strokeWidth={2}
					/>
				) : (
					<Check className="size-3 text-app-positive" strokeWidth={2} />
				)}
				<span className="shrink-0 cursor-pointer text-app-muted/40 hover:text-app-muted">
					<svg
						className="size-2.5 group-open/collapse:rotate-90"
						viewBox="0 0 12 12"
						fill="none"
					>
						<path
							d="M4.5 2.5L8.5 6L4.5 9.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</span>
				<span className="shrink-0 text-[11px] text-app-muted/40">
					{group.tools.length} tools
				</span>
			</summary>
			{open ? (
				<div className="ml-5 flex flex-col gap-0.5 border-l border-app-border/30 pl-3 pt-1">
					{group.tools.map((tool, idx) => (
						<AssistantToolCall
							key={tool.toolCallId ?? `${tool.toolName}:${idx}`}
							toolName={tool.toolName}
							args={tool.args}
							result={tool.result}
							isError={tool.isError}
							toolUseResult={tool.toolUseResult}
						/>
					))}
				</div>
			) : null}
		</details>
	);
}

function CopyMessageButton() {
	const [copied, setCopied] = useState(false);
	const ref = useRef<HTMLButtonElement>(null);

	const handleCopy = useCallback(() => {
		const root =
			ref.current?.closest("[data-message-role]") ?? ref.current?.parentElement;
		if (!root) return;
		const text = root.textContent ?? "";
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, []);

	return (
		<button
			ref={ref}
			type="button"
			onClick={handleCopy}
			className="flex size-5 shrink-0 items-center justify-center rounded text-app-muted/30 opacity-0 transition-all hover:text-app-muted group-hover/sys:opacity-100"
		>
			{copied ? (
				<Check className="size-3" strokeWidth={2} />
			) : (
				<Copy className="size-3" strokeWidth={1.8} />
			)}
		</button>
	);
}

function EditDiffTrigger({
	file,
	diffAdd,
	diffDel,
	oldStr,
	newStr,
}: {
	file: string;
	diffAdd?: number;
	diffDel?: number;
	oldStr: string | null;
	newStr: string | null;
}) {
	const triggerRef = useRef<HTMLSpanElement>(null);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	const show = useCallback(() => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
		if (triggerRef.current) {
			const r = triggerRef.current.getBoundingClientRect();
			setPos({ x: r.left, y: r.bottom + 4 });
		}
	}, []);
	const hideDelayed = useCallback(() => {
		hideTimer.current = setTimeout(() => setPos(null), 120);
	}, []);

	return (
		<>
			<span
				ref={triggerRef}
				onMouseEnter={show}
				onMouseLeave={hideDelayed}
				className="inline-flex cursor-default items-center gap-1.5 rounded border border-app-border/60 px-1.5 py-0.5 transition-colors hover:border-app-foreground-soft/40 hover:bg-app-foreground/[0.03]"
			>
				<span className="truncate text-app-foreground-soft">{file}</span>
				{diffAdd != null || diffDel != null ? (
					<span className="flex items-center gap-1 text-[11px]">
						{diffAdd != null ? (
							<span className="text-app-positive">+{diffAdd}</span>
						) : null}
						{diffDel != null ? (
							<span className="text-app-negative">-{diffDel}</span>
						) : null}
					</span>
				) : null}
			</span>
			{pos
				? createPortal(
						<div
							onMouseEnter={show}
							onMouseLeave={hideDelayed}
							className="fixed z-[100] w-[min(40rem,90vw)] rounded-lg border border-app-border bg-app-tooltip shadow-xl"
							style={{ left: pos.x, top: pos.y }}
						>
							<div className="border-b border-app-border/50 px-3 py-1.5 text-[11px] text-app-muted">
								{file}
							</div>
							<div className="max-h-[24rem] overflow-auto font-mono text-[11px] leading-5">
								{oldStr
									? oldStr.split("\n").map((line, i) => (
											<div
												key={`d${i}`}
												className="flex whitespace-pre-wrap bg-app-negative/10"
											>
												<span className="w-8 shrink-0 select-none border-r border-app-border/20 pr-1 text-right text-app-negative/40">
													{i + 1}
												</span>
												<span className="w-4 shrink-0 select-none text-center text-app-negative/60">
													-
												</span>
												<span className="min-w-0 text-app-negative/80">
													{line}
												</span>
											</div>
										))
									: null}
								{oldStr && newStr ? (
									<div className="border-t border-app-border/30" />
								) : null}
								{newStr
									? newStr.split("\n").map((line, i) => (
											<div
												key={`a${i}`}
												className="flex whitespace-pre-wrap bg-app-positive/10"
											>
												<span className="w-8 shrink-0 select-none border-r border-app-border/20 pr-1 text-right text-app-positive/40">
													{i + 1}
												</span>
												<span className="w-4 shrink-0 select-none text-center text-app-positive/60">
													+
												</span>
												<span className="min-w-0 text-app-positive/80">
													{line}
												</span>
											</div>
										))
									: null}
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}

function isTextPart(
	part: unknown,
): part is Extract<MessagePart, { type: "text" }> {
	return isObj(part) && part.type === "text" && typeof part.text === "string";
}

function isReasoningPart(
	part: unknown,
): part is Extract<MessagePart, { type: "reasoning" }> {
	return (
		isObj(part) && part.type === "reasoning" && typeof part.text === "string"
	);
}

function isToolCallPart(
	part: unknown,
): part is Extract<MessagePart, { type: "tool-call" }> {
	return (
		isObj(part) &&
		part.type === "tool-call" &&
		typeof part.toolName === "string" &&
		isObj(part.args)
	);
}

function isCollapsedGroupPart(part: unknown): part is CollapsedGroupPart {
	return (
		isObj(part) && part.type === "collapsed-group" && Array.isArray(part.tools)
	);
}

function isSystemNoticePart(part: unknown): part is SystemNoticePart {
	return (
		isObj(part) &&
		part.type === "system-notice" &&
		typeof part.label === "string" &&
		(part.severity === "info" ||
			part.severity === "warning" ||
			part.severity === "error")
	);
}

function isTodoListPart(part: unknown): part is TodoListPart {
	return isObj(part) && part.type === "todo-list" && Array.isArray(part.items);
}

function isImagePart(part: unknown): part is ImagePart {
	return isObj(part) && part.type === "image" && isObj(part.source);
}

function isPromptSuggestionPart(part: unknown): part is PromptSuggestionPart {
	return (
		isObj(part) &&
		part.type === "prompt-suggestion" &&
		typeof part.text === "string"
	);
}

function isFileMentionPart(part: unknown): part is FileMentionPart {
	return (
		isObj(part) && part.type === "file-mention" && typeof part.path === "string"
	);
}

function SystemText({ text }: { text: string }) {
	if (text.startsWith("Error:")) {
		return (
			<span className="inline-flex items-center gap-1 text-app-negative">
				<AlertCircle className="size-3 shrink-0" strokeWidth={1.8} />
				{text.slice(7)}
			</span>
		);
	}
	return <span>{text}</span>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

type ToolInfo = {
	action: string;
	file?: string;
	detail?: string;
	command?: string;
	fullCommand?: string;
	icon: React.ReactNode;
	diffAdd?: number;
	diffDel?: number;
	/** Plain-text body to show in the expandable details panel for tools
	 *  whose payload lives in `args` rather than `result` (e.g. the
	 *  synthetic Prompt tool that wraps a subagent's instructions —
	 *  there's no "result" because the prompt IS the input). When set,
	 *  `AssistantToolCall` treats it the same as a tool's stdout: the
	 *  details twist appears, click to expand, content renders in the
	 *  same `<pre>` block. */
	body?: string;
};

function getToolInfo(
	name: string,
	input: Record<string, unknown> | null,
): ToolInfo {
	const fallbackIcon = (
		<span className="size-3.5 rounded-full bg-app-foreground/15" />
	);
	if (!input) return { action: name, icon: fallbackIcon };

	if (name === "Edit") {
		const fp = str(input.file_path);
		const oldStr = typeof input.old_string === "string" ? input.old_string : "";
		const newStr = typeof input.new_string === "string" ? input.new_string : "";
		const del = oldStr ? oldStr.split("\n").length : 0;
		const add = newStr ? newStr.split("\n").length : 0;
		return {
			action: "Edit",
			file: fp ? basename(fp) : undefined,
			icon: <Pencil className="size-3.5 text-app-warning" strokeWidth={1.8} />,
			diffAdd: add,
			diffDel: del,
		};
	}

	if (name === "Read") {
		const fp = str(input.file_path);
		const limit = typeof input.limit === "number" ? input.limit : null;
		return {
			action: limit ? `Read ${limit} lines` : "Read",
			file: fp ? basename(fp) : undefined,
			icon: <FileText className="size-3.5 text-app-info" strokeWidth={1.8} />,
		};
	}

	if (name === "Write") {
		const fp = str(input.file_path);
		return {
			action: "Write",
			file: fp ? basename(fp) : undefined,
			icon: (
				<FilePlus className="size-3.5 text-app-positive" strokeWidth={1.8} />
			),
		};
	}

	if (name === "Bash") {
		const cmd = str(input.command);
		// Claude Bash tool's `description` is a 5-10 word human label of the command.
		const desc = str(input.description);
		return {
			action: desc ?? "Run",
			icon: (
				<SquareTerminal
					className="size-3.5 text-app-foreground-soft"
					strokeWidth={1.8}
				/>
			),
			command: cmd ? truncate(cmd, 80) : undefined,
			fullCommand: cmd ?? undefined,
		};
	}

	if (name === "Grep") {
		const p = str(input.pattern);
		return {
			action: "Grep",
			icon: <Search className="size-3.5 text-app-info" strokeWidth={1.8} />,
			detail: p ?? undefined,
		};
	}

	if (name === "Glob") {
		const p = str(input.pattern);
		return {
			action: "Glob",
			icon: (
				<FolderSearch className="size-3.5 text-app-info" strokeWidth={1.8} />
			),
			detail: p ?? undefined,
		};
	}

	if (name === "WebFetch") {
		const url = str(input.url);
		return {
			action: "WebFetch",
			icon: <Globe className="size-3.5 text-app-project" strokeWidth={1.8} />,
			detail: url ? truncate(url, 60) : undefined,
		};
	}

	if (name === "WebSearch") {
		const q = str(input.query);
		return {
			action: "WebSearch",
			icon: <Globe className="size-3.5 text-app-project" strokeWidth={1.8} />,
			detail: q ? truncate(q, 50) : undefined,
		};
	}

	if (name === "ToolSearch") {
		const q = str(input.query);
		return {
			action: "ToolSearch",
			icon: <Search className="size-3.5 text-app-info" strokeWidth={1.8} />,
			detail: q ? truncate(q, 50) : undefined,
		};
	}

	if (name === "Agent" || name === "Task") {
		// Claude Code-style: prefer the subagent_type as the action label
		// (e.g. "Explore", "Plan", "general-purpose"), with the
		// description as the detail. Falls back to the generic "Agent" /
		// "Task" if subagent_type is missing on older sessions.
		const subagentType = str(input.subagent_type);
		const d = str(input.description) ?? str(input.prompt);
		return {
			action: subagentType ?? name,
			icon: <Bot className="size-3.5 text-app-info" strokeWidth={1.8} />,
			detail: d ? truncate(d, 60) : undefined,
		};
	}

	if (name === "Prompt") {
		// Synthesized by the Rust pipeline (`adapter/mod.rs`) for the
		// initial instruction text the parent assistant sends to a
		// subagent. The text lives in `args.text` (not `result`), so
		// we surface it via the new `body` field — `AssistantToolCall`
		// then renders it in the same expandable details panel every
		// other tool uses for its stdout. Click to twist open, same
		// chevron, same `<pre>` block, same affordance.
		const text = str(input.text);
		return {
			action: "Prompt",
			icon: (
				<MessageSquareText
					className="size-3.5 text-app-info"
					strokeWidth={1.8}
				/>
			),
			body: text ?? undefined,
		};
	}

	return { action: name, icon: fallbackIcon };
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v : null;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function basename(path: string): string {
	return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function EmptyState({ hasSession }: { hasSession: boolean }) {
	return (
		<div className="m-auto flex max-w-sm flex-col items-center px-8 text-center">
			<MessageSquareText
				className="size-7 text-app-muted/80"
				strokeWidth={1.7}
			/>
			<p className="mt-5 text-[15px] font-medium tracking-[-0.01em] text-app-foreground">
				{hasSession ? "Nothing here yet" : "No session selected"}
			</p>
			<p className="mt-2 max-w-[30rem] text-[13px] leading-6 text-app-muted">
				{hasSession
					? "This session does not have any messages yet."
					: "Choose a session from the header to inspect its timeline."}
			</p>
		</div>
	);
}

function SessionProviderIcon({
	agentType,
	active,
}: {
	agentType?: string | null;
	active: boolean;
}) {
	if (active) {
		return (
			<span className="relative flex size-3.5 shrink-0 items-center justify-center">
				<span className="absolute inset-0 animate-spin rounded-full border border-transparent border-t-app-progress" />
				<span className="size-1.5 rounded-full bg-app-progress" />
			</span>
		);
	}
	if (agentType === "codex") {
		return <OpenAIIcon className="size-3 shrink-0 text-app-foreground-soft" />;
	}
	return <ClaudeIcon className="size-3 shrink-0 text-app-foreground-soft" />;
}

function displaySessionTitle(session: WorkspaceSessionSummary): string {
	if (session.title && session.title !== "Untitled") return session.title;
	return "Untitled";
}

function BranchPicker({
	currentBranch,
	branches,
	loading,
	onOpen,
	onSelect,
}: {
	currentBranch: string;
	branches: string[];
	loading: boolean;
	onOpen: () => void;
	onSelect: (branch: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) onOpen();
			}}
		>
			<PopoverTrigger className="inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1 py-0.5 text-[13px] font-medium text-app-foreground-soft transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground focus-visible:outline-none">
				<span className="truncate">{currentBranch}</span>
				<ChevronDown className="size-3 shrink-0" strokeWidth={2} />
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[280px] p-0">
				<Command>
					<CommandInput placeholder="Search branches..." />
					<CommandList className="max-h-56">
						{loading && branches.length === 0 ? (
							<div className="flex items-center justify-center gap-2 py-6 text-[13px] text-app-muted">
								<LoaderCircle
									className="size-3.5 animate-spin"
									strokeWidth={2}
								/>
								Loading branches...
							</div>
						) : null}
						<CommandEmpty>No branches found</CommandEmpty>
						{branches.map((branch) => (
							<CommandItem
								key={branch}
								value={branch}
								onSelect={() => {
									onSelect(branch);
									setOpen(false);
								}}
								className="flex items-center justify-between gap-2"
							>
								<span
									className={cn(
										"truncate",
										branch === currentBranch && "font-semibold",
									)}
								>
									{branch}
								</span>
								{branch === currentBranch && (
									<Check className="size-3.5 shrink-0" strokeWidth={2} />
								)}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
