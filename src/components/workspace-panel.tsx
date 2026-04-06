import { useQuery } from "@tanstack/react-query";
import {
	AlertCircle,
	ArrowDown,
	ArrowRight,
	Bot,
	Check,
	ChevronDown,
	Clock3,
	Copy,
	FilePlus,
	FileText,
	FolderSearch,
	GitBranch,
	Globe,
	History,
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
	lazy,
	memo,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	type StateSnapshot,
	Virtuoso,
	type Components as VirtuosoComponents,
	type VirtuosoHandle,
	type ItemProps as VirtuosoItemProps,
} from "react-virtuoso";
import {
	createSession,
	deleteSession,
	hideSession,
	listRemoteBranches,
	loadHiddenSessions,
	renameSession,
	type SessionAttachmentRecord,
	type SessionMessageRecord,
	unhideSession,
	updateIntendedTargetBranch,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { recordMessageRender } from "@/lib/dev-render-debug";
import {
	type CollapsedGroupPart,
	convertMessages,
	type ExtendedMessagePart,
	type MessagePart,
	type ToolCallPart,
} from "@/lib/message-adapter";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
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
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type WorkspacePanelProps = {
	workspace: WorkspaceDetail | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	selectedProvider?: string | null;
	visibleSessionId?: string | null;
	preparingSessionId?: string | null;
	coldRevealSessionId?: string | null;
	sessionPanes: Array<{
		sessionId: string;
		messages: SessionMessageRecord[];
		sending: boolean;
		hasLoaded: boolean;
		presentationState: "cold-unpresented" | "presented";
		viewportSnapshot?: StateSnapshot;
		layoutCacheKey?: string | null;
		lastMeasuredAt?: number;
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
	onSessionMeasurements?: (
		sessionId: string,
		payload: {
			viewportSnapshot?: StateSnapshot;
			layoutCacheKey?: string | null;
			lastMeasuredAt?: number;
		},
	) => void;
	onSessionPrepared?: (
		sessionId: string,
		payload: {
			viewportSnapshot?: StateSnapshot;
			layoutCacheKey?: string | null;
			lastMeasuredAt?: number;
		},
	) => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
};

type RenderedMessage = ReturnType<typeof convertMessages>[number];
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
const sessionViewportStateBySession = new Map<string, StateSnapshot>();
const CHAT_LAYOUT_CACHE_VERSION = "chat-layout-v1";

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
	visibleSessionId = selectedSessionId,
	preparingSessionId = null,
	coldRevealSessionId = null,
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
	onSessionMeasurements,
	onSessionPrepared,
	headerActions,
	headerLeading,
}: WorkspacePanelProps) {
	const selectedSession =
		sessions.find((s) => s.id === selectedSessionId) ?? null;
	const visiblePane =
		sessionPanes.find((pane) => pane.sessionId === visibleSessionId) ?? null;
	const [showHistory, setShowHistory] = useState(false);
	const [hiddenSessions, setHiddenSessions] = useState<
		WorkspaceSessionSummary[]
	>([]);
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
			// The container invalidates workspace/session queries so selection can
			// reconcile against the refreshed visible-session list.
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
		<div className="flex min-h-0 flex-1 flex-col bg-transparent">
			{/* --- Header --- */}
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
							<span className="truncate">
								{workspace?.branch ?? "No branch"}
							</span>
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
										onOpen={() => branchesQuery.refetch()}
										onSelect={(branch: string) => {
											if (branch === workspace.intendedTargetBranch) return;
											void updateIntendedTargetBranch(
												workspace.id,
												branch,
											).then(() => {
												onWorkspaceChanged?.();
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
															ref={(element) => element?.focus()}
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

			{/* --- Timeline --- */}
			<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
				{loadingWorkspace || loadingSession ? (
					<ConversationColdPlaceholder />
				) : visibleSessionId && visiblePane?.hasLoaded ? (
					<KeepAliveThreadStack
						coldRevealSessionId={coldRevealSessionId}
						visibleSessionId={visibleSessionId}
						preparingSessionId={preparingSessionId}
						hasSession={!!selectedSession}
						sessionPanes={sessionPanes}
						onSessionMeasurements={onSessionMeasurements}
						onSessionPrepared={onSessionPrepared}
					/>
				) : (
					<EmptyState hasSession={!!selectedSession} />
				)}
			</div>
		</div>
	);
});

function KeepAliveThreadStack({
	coldRevealSessionId,
	visibleSessionId,
	preparingSessionId,
	hasSession,
	sessionPanes,
	onSessionMeasurements,
	onSessionPrepared,
}: {
	coldRevealSessionId: string | null;
	visibleSessionId: string;
	preparingSessionId: string | null;
	hasSession: boolean;
	sessionPanes: Array<{
		sessionId: string;
		messages: SessionMessageRecord[];
		sending: boolean;
		hasLoaded: boolean;
		presentationState: "cold-unpresented" | "presented";
		viewportSnapshot?: StateSnapshot;
		layoutCacheKey?: string | null;
		lastMeasuredAt?: number;
	}>;
	onSessionMeasurements?: WorkspacePanelProps["onSessionMeasurements"];
	onSessionPrepared?: WorkspacePanelProps["onSessionPrepared"];
}) {
	const stackRef = useRef<HTMLDivElement | null>(null);
	const [widthBucket, setWidthBucket] = useState(0);

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
			{sessionPanes.map((pane) => {
				const mode =
					pane.sessionId === visibleSessionId
						? "visible"
						: pane.sessionId === preparingSessionId
							? "preparing"
							: "parked";
				const layoutCacheKey = getSessionLayoutCacheKey(
					pane.sessionId,
					pane.messages,
					widthBucket,
				);
				const initialSnapshot =
					pane.layoutCacheKey === layoutCacheKey
						? pane.viewportSnapshot
						: undefined;
				return (
					<div
						key={pane.sessionId}
						aria-hidden={mode === "visible" ? undefined : true}
						className={cn(
							"min-h-0",
							mode === "visible"
								? "relative z-10 flex flex-1"
								: "absolute inset-0 flex pointer-events-none",
							mode === "visible" && pane.sessionId === coldRevealSessionId
								? "conversation-thread-enter"
								: null,
						)}
						style={{
							opacity: mode === "preparing" ? 0 : 1,
							visibility: mode === "parked" ? "hidden" : "visible",
						}}
					>
						{pane.messages.length > 0 ? (
							<ChatThread
								initialSnapshot={initialSnapshot}
								layoutCacheKey={layoutCacheKey}
								messages={pane.messages}
								mode={mode}
								onPrepared={onSessionPrepared}
								onViewportSnapshot={onSessionMeasurements}
								sessionId={pane.sessionId}
								sending={pane.sending}
							/>
						) : (
							<div className="flex min-h-0 flex-1 flex-col">
								<EmptyState hasSession={hasSession} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Stick-to-bottom powered thread
// ---------------------------------------------------------------------------

function ChatThread({
	initialSnapshot,
	layoutCacheKey,
	messages,
	mode,
	onPrepared,
	onViewportSnapshot,
	sessionId,
	sending,
}: {
	initialSnapshot?: StateSnapshot;
	layoutCacheKey: string;
	messages: SessionMessageRecord[];
	mode: "visible" | "preparing" | "parked";
	onPrepared?: WorkspacePanelProps["onSessionPrepared"];
	onViewportSnapshot?: WorkspacePanelProps["onSessionMeasurements"];
	sessionId: string;
	sending: boolean;
}) {
	const threadMessages = useMemo(
		() => convertMessages(messages, sessionId, { collapse: true }),
		[messages, sessionId],
	);
	const virtuosoRef = useRef<VirtuosoHandle | null>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const isAtBottomRef = useRef(true);
	const preparePhaseRef = useRef<"idle" | "waiting-bottom">("idle");
	const prepareRunIdRef = useRef(0);
	const prepareFinishRef = useRef<(() => void) | null>(null);
	const restoredViewportState = useMemo(
		() => initialSnapshot ?? sessionViewportStateBySession.get(sessionId),
		[initialSnapshot, sessionId],
	);
	const previousSendingRef = useRef(sending);
	const sendingJustStarted = sending && !previousSendingRef.current;
	const sendingRef = useRef(sending);
	sendingRef.current = sending;

	useEffect(() => {
		previousSendingRef.current = sending;
	}, [sending]);

	useEffect(() => {
		isAtBottomRef.current = isAtBottom;
	}, [isAtBottom]);

	useEffect(() => {
		return () => {
			const virtuoso = virtuosoRef.current;
			if (!virtuoso) return;
			virtuoso.getState((snapshot) => {
				sessionViewportStateBySession.set(sessionId, snapshot);
			});
		};
	}, [sessionId]);

	const scrollThreadToBottom = useCallback(() => {
		const virtuoso = virtuosoRef.current;
		if (!virtuoso) return;

		virtuoso.scrollToIndex({
			index: "LAST",
			align: "end",
			behavior: "auto",
		});
	}, []);

	const captureViewportSnapshot = useCallback(
		(
			callback?: (payload: {
				viewportSnapshot?: StateSnapshot;
				layoutCacheKey?: string | null;
				lastMeasuredAt?: number;
			}) => void,
		) => {
			const virtuoso = virtuosoRef.current;
			if (!virtuoso) {
				const payload = {
					viewportSnapshot: undefined,
					layoutCacheKey,
					lastMeasuredAt: Date.now(),
				};
				onViewportSnapshot?.(sessionId, payload);
				callback?.(payload);
				return;
			}

			virtuoso.getState((snapshot) => {
				sessionViewportStateBySession.set(sessionId, snapshot);
				const payload = {
					viewportSnapshot: snapshot,
					layoutCacheKey,
					lastMeasuredAt: Date.now(),
				};
				onViewportSnapshot?.(sessionId, payload);
				callback?.(payload);
			});
		},
		[layoutCacheKey, onViewportSnapshot, sessionId],
	);

	useEffect(() => {
		if (sendingJustStarted) {
			scrollThreadToBottom();
		}
	}, [sendingJustStarted, scrollThreadToBottom]);

	useEffect(() => {
		return () => {
			if (mode === "visible" || mode === "preparing") {
				captureViewportSnapshot();
			}
		};
	}, [captureViewportSnapshot, mode]);

	useEffect(() => {
		if (mode !== "preparing" || typeof window === "undefined") {
			preparePhaseRef.current = "idle";
			prepareFinishRef.current = null;
			return;
		}

		prepareRunIdRef.current += 1;
		const runId = prepareRunIdRef.current;
		let frameId = 0;
		let nestedFrameId = 0;
		let settleFrameId = 0;
		let timeoutId = 0;
		const finishPrepare = () => {
			if (prepareRunIdRef.current !== runId) {
				return;
			}

			preparePhaseRef.current = "idle";
			captureViewportSnapshot((payload) => {
				if (prepareRunIdRef.current !== runId) {
					return;
				}
				onPrepared?.(sessionId, payload);
			});
		};

		prepareFinishRef.current = finishPrepare;
		frameId = window.requestAnimationFrame(() => {
			nestedFrameId = window.requestAnimationFrame(() => {
				scrollThreadToBottom();
				preparePhaseRef.current = "waiting-bottom";
				settleFrameId = window.requestAnimationFrame(() => {
					if (isAtBottomRef.current) {
						finishPrepare();
						return;
					}

					timeoutId = window.setTimeout(() => {
						finishPrepare();
					}, 64);
				});
			});
		});

		return () => {
			if (frameId !== 0) {
				window.cancelAnimationFrame(frameId);
			}
			if (nestedFrameId !== 0) {
				window.cancelAnimationFrame(nestedFrameId);
			}
			if (settleFrameId !== 0) {
				window.cancelAnimationFrame(settleFrameId);
			}
			if (timeoutId !== 0) {
				window.clearTimeout(timeoutId);
			}
			if (prepareRunIdRef.current === runId) {
				preparePhaseRef.current = "idle";
				prepareFinishRef.current = null;
			}
		};
	}, [
		captureViewportSnapshot,
		layoutCacheKey,
		mode,
		onPrepared,
		scrollThreadToBottom,
		sessionId,
		threadMessages,
	]);

	useEffect(() => {
		if (
			mode === "preparing" &&
			preparePhaseRef.current === "waiting-bottom" &&
			isAtBottom
		) {
			prepareFinishRef.current?.();
		}
	}, [isAtBottom, mode]);

	const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
		setIsAtBottom(atBottom);
	}, []);

	const virtuosoComponents = useMemo<VirtuosoComponents<RenderedMessage>>(
		() => ({
			Header: ConversationHeaderSpacer,
			Item: ConversationItem,
			Footer: sending ? StreamingFooter : undefined,
		}),
		[sending],
	);

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

	// Stable followOutput callback
	const followOutput = useCallback(
		(atBottom: boolean) =>
			sendingRef.current && atBottom ? ("auto" as const) : false,
		[],
	);

	return (
		<ConversationViewport
			components={virtuosoComponents}
			data={threadMessages}
			followOutput={followOutput}
			itemContent={itemContent}
			onAtBottomStateChange={handleAtBottomStateChange}
			restoredViewportState={restoredViewportState}
			virtuosoRef={virtuosoRef}
		>
			<button
				type="button"
				onClick={() => {
					scrollThreadToBottom();
				}}
				className={`conversation-scroll-button ${isAtBottom || sendingJustStarted ? "conversation-scroll-button-hidden" : ""}`}
				aria-label="Scroll to latest message"
			>
				<ArrowDown className="size-4" strokeWidth={2} />
			</button>
		</ConversationViewport>
	);
}

// ---------------------------------------------------------------------------
// Message components
// ---------------------------------------------------------------------------

function ConversationViewport({
	children,
	components,
	data,
	followOutput,
	itemContent,
	onAtBottomStateChange,
	restoredViewportState,
	virtuosoRef,
}: {
	children?: ReactNode;
	components: VirtuosoComponents<RenderedMessage>;
	data: RenderedMessage[];
	followOutput: "auto" | false | ((isAtBottom: boolean) => "auto" | false);
	itemContent: (index: number, message: RenderedMessage) => ReactNode;
	onAtBottomStateChange: (atBottom: boolean) => void;
	restoredViewportState?: StateSnapshot;
	virtuosoRef: React.RefObject<VirtuosoHandle | null>;
}) {
	const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);

	return (
		<ScrollArea
			className="relative min-h-0 flex-1"
			viewportRef={setScrollParent}
			viewportClassName="conversation-scroll-viewport"
			overlay={children}
		>
			{scrollParent ? (
				<Virtuoso
					ref={virtuosoRef}
					alignToBottom
					atBottomStateChange={onAtBottomStateChange}
					atBottomThreshold={48}
					components={components}
					computeItemKey={(index, message) =>
						message.id ?? `${message.role}:${index}`
					}
					customScrollParent={scrollParent}
					data={data}
					defaultItemHeight={92}
					followOutput={followOutput}
					initialTopMostItemIndex={
						restoredViewportState ? undefined : { index: "LAST", align: "end" }
					}
					increaseViewportBy={{ bottom: 720, top: 360 }}
					itemContent={itemContent}
					minOverscanItemCount={{ top: 8, bottom: 4 }}
					overscan={{ main: 600, reverse: 300 }}
					restoreStateFrom={restoredViewportState}
					skipAnimationFrameInResizeObserver
				/>
			) : null}
		</ScrollArea>
	);
}

function getSessionLayoutCacheKey(
	sessionId: string,
	messages: SessionMessageRecord[],
	widthBucket: number,
) {
	let hash = 0;

	for (const message of messages) {
		const signature = [
			message.id,
			message.role,
			message.createdAt,
			message.contentIsJson ? "json" : "text",
			String(message.content.length),
			String(message.attachmentCount ?? 0),
		].join("|");

		for (let index = 0; index < signature.length; index += 1) {
			hash = (hash * 31 + signature.charCodeAt(index)) >>> 0;
		}
	}

	return [
		CHAT_LAYOUT_CACHE_VERSION,
		sessionId,
		String(widthBucket),
		String(messages.length),
		String(hash),
	].join(":");
}

const ConversationItem = memo(function ConversationItem({
	children,
	style,
	item: _item,
	...props
}: VirtuosoItemProps<RenderedMessage>) {
	return (
		<div {...props} style={style} className="flow-root px-5 pb-1.5">
			{children}
		</div>
	);
});

function ConversationColdPlaceholder() {
	return <div className="flex min-h-0 flex-1" aria-hidden="true" />;
}

function ConversationHeaderSpacer() {
	return <div className="h-6 shrink-0" />;
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
	recordMessageRender(sessionId, message.id ?? `${message.role}:${itemIndex}`);

	// Derive streaming state from the message itself — avoids external prop
	// that changes callback references and causes Virtuoso re-renders.
	const streaming =
		message.role === "assistant" &&
		(message.streaming === true ||
			message.id?.startsWith("stream:") === true ||
			message.id?.endsWith(":stream-partial") === true);

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
				{parts.map((part, idx) =>
					isTextPart(part) ? <UserText key={idx} text={part.text} /> : null,
				)}
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

	return (
		<div
			data-message-id={message.id}
			data-message-role="assistant"
			className="flex min-w-0 max-w-full flex-col gap-1"
		>
			{parts.map((part, idx) => {
				if (isTextPart(part)) {
					return (
						<AssistantText key={idx} text={part.text} streaming={streaming} />
					);
				}
				if (isReasoningPart(part)) {
					return (
						<AssistantReasoning
							key={idx}
							text={part.text}
							streaming={streaming}
						/>
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
							key={part.toolCallId ?? `${part.toolName}:${idx}`}
							toolName={part.toolName}
							args={part.args}
							result={part.result}
							streamingStatus={(part as ToolCallPart).streamingStatus}
						/>
					);
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
				{parts.map((part, idx) =>
					isTextPart(part) ? <SystemText key={idx} text={part.text} /> : null,
				)}
			</div>
			<CopyMessageButton />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Content part components
// ---------------------------------------------------------------------------

/** Regex matching @/path/to/file.ext references (images and general files). */
const USER_FILE_RE = /@(\/\S+?\.\w+)(?=\s|$)/gi;

/** Image extensions for distinguishing images from other files. */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;

type UserContentSegment =
	| { type: "text"; value: string }
	| { type: "image"; value: string }
	| { type: "file"; value: string };

/** Split user text into interleaved text, image, and file segments. */
function splitUserContent(text: string): UserContentSegment[] {
	const segments: UserContentSegment[] = [];
	let lastIndex = 0;
	USER_FILE_RE.lastIndex = 0;
	for (
		let match = USER_FILE_RE.exec(text);
		match !== null;
		match = USER_FILE_RE.exec(text)
	) {
		const before = text.slice(lastIndex, match.index);
		if (before) segments.push({ type: "text", value: before });
		const filePath = match[1];
		segments.push({
			type: IMAGE_EXT_RE.test(filePath) ? "image" : "file",
			value: filePath,
		});
		lastIndex = match.index + match[0].length;
	}
	const after = text.slice(lastIndex);
	if (after) segments.push({ type: "text", value: after });
	return segments;
}

function UserText({ text }: { text: string }) {
	const segments = splitUserContent(text);
	const hasAttachments = segments.some(
		(s) => s.type === "image" || s.type === "file",
	);

	if (!hasAttachments) {
		return <p className="whitespace-pre-wrap break-words">{text}</p>;
	}

	return (
		<p className="whitespace-pre-wrap break-words">
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
		</p>
	);
}

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

function AssistantText({
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
			className="conversation-markdown prose prose-sm max-w-none break-words leading-6 text-app-foreground prose-headings:my-0 prose-headings:text-app-foreground prose-p:my-0 prose-p:text-app-foreground prose-li:my-0 prose-li:text-app-foreground prose-strong:text-app-foreground prose-em:text-app-foreground prose-pre:my-0 prose-pre:border prose-pre:border-app-border prose-pre:bg-app-sidebar prose-pre:text-[12px] prose-pre:text-app-foreground prose-ul:my-0 prose-ol:my-0 prose-blockquote:my-0 prose-blockquote:border-app-border prose-blockquote:text-app-muted prose-table:my-0 prose-table:text-[11px] prose-table:text-app-foreground prose-th:border-app-border prose-th:text-app-foreground prose-td:border-app-border prose-td:text-app-foreground prose-tr:border-app-border prose-a:text-app-project prose-a:underline prose-a:decoration-app-project/30 prose-code:rounded prose-code:border prose-code:border-app-border/50 prose-code:bg-app-sidebar prose-code:px-1 prose-code:py-px prose-code:text-[12px] prose-code:text-app-foreground-soft"
			style={{ fontSize: `${settings.fontSize}px` }}
		>
			<Suspense
				fallback={<AssistantTextFallback text={text} streaming={streaming} />}
			>
				<LazyStreamdown
					animated={
						streaming
							? {
									animation: "blurIn",
									duration: 150,
									easing: "linear",
									sep: "word",
									stagger: 30,
								}
							: false
					}
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
}

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

function AssistantReasoning({
	text,
	streaming,
}: {
	text: string;
	streaming?: boolean;
}) {
	const { settings } = useSettings();

	return (
		<details className="group flex flex-col" open={streaming || undefined}>
			<summary className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-app-muted hover:text-app-foreground-soft [&::-webkit-details-marker]:hidden">
				<svg
					className="size-2.5 shrink-0 transition-transform group-open:rotate-90"
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
				Thinking
				{streaming ? (
					<LoaderCircle
						className="size-3 animate-spin text-app-muted/50"
						strokeWidth={2}
					/>
				) : null}
			</summary>
			<div className="pt-1.5">
				<pre
					className="max-h-[20rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app-foreground/[0.03] px-3 py-2.5 font-sans leading-relaxed text-app-muted/70"
					style={{ fontSize: `${settings.fontSize}px` }}
				>
					{text}
				</pre>
			</div>
		</details>
	);
}

function AssistantToolCall({
	toolName,
	args,
	result,
	streamingStatus,
}: {
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
	streamingStatus?: string;
}) {
	const info = getToolInfo(toolName, args);
	const isEdit = toolName === "Edit";
	const oldStr =
		isEdit && typeof args.old_string === "string" ? args.old_string : null;
	const newStr =
		isEdit && typeof args.new_string === "string" ? args.new_string : null;
	const hasDiff = oldStr != null || newStr != null;

	// Detect __children__ encoded in result (sub-agent steps)
	const resultStr =
		result != null
			? typeof result === "string"
				? result
				: JSON.stringify(result, null, 2)
			: null;
	const isChildrenResult = resultStr?.startsWith("__children__") ?? false;
	const childrenData = isChildrenResult
		? (() => {
				try {
					return JSON.parse(resultStr!.slice("__children__".length)) as {
						parts: Array<Record<string, unknown>>;
					};
				} catch {
					return null;
				}
			})()
		: null;
	const resultText = isChildrenResult ? null : resultStr;
	const hasOutput = resultText != null && resultText.length > 5;

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
			<span className="font-medium">{info.action}</span>
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
				<code className="truncate rounded bg-app-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-app-foreground-soft">
					{info.command}
				</code>
			) : info.detail ? (
				<span className="truncate text-app-muted/60">{info.detail}</span>
			) : null}
			{statusIndicator}
		</>
	);

	// Sub-agent children: show last N steps with "show more" toggle
	if (childrenData) {
		return (
			<AgentChildrenBlock
				toolLine={toolLine}
				parts={childrenData.parts}
				streaming={!!streamingStatus}
			/>
		);
	}

	// Normal tool call with optional output
	return (
		<details className="group/out flex flex-col" open={false}>
			<summary className="flex max-w-full cursor-default items-center gap-1.5 py-0.5 text-[12px] text-app-muted [&::-webkit-details-marker]:hidden">
				{toolLine}
				{hasOutput ? (
					<span className="shrink-0 cursor-pointer text-app-muted/40 hover:text-app-muted">
						<svg
							className="size-2.5 transition-transform group-open/out:rotate-90"
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
			{hasOutput ? (
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
	);
}

/** Number of recent children steps to show by default. */
const AGENT_PREVIEW_STEPS = 3;

function AgentChildrenBlock({
	toolLine,
	parts,
	streaming,
}: {
	toolLine: React.ReactNode;
	parts: Array<Record<string, unknown>>;
	streaming: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const totalSteps = parts.length;
	const hasMore = totalSteps > AGENT_PREVIEW_STEPS;

	// When streaming, always show the latest N steps (tail).
	// When completed + not expanded, show last N steps.
	// When expanded, show all.
	const visibleParts =
		expanded || !hasMore ? parts : parts.slice(-AGENT_PREVIEW_STEPS);

	const hiddenCount = totalSteps - visibleParts.length;

	return (
		<div className="flex flex-col">
			{/* Header line: icon + tool name + step count */}
			<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-app-muted">
				{toolLine}
				{streaming ? (
					<LoaderCircle
						className="size-3 animate-spin text-app-progress"
						strokeWidth={2}
					/>
				) : null}
				<span className="shrink-0 text-[11px] text-app-muted/40">
					{totalSteps} steps
				</span>
			</div>

			{/* Children steps */}
			<div className="ml-5 flex flex-col gap-0.5 border-l border-app-border/30 pl-3 pt-1">
				{/* "Show more" / "Collapse" toggle */}
				{hasMore && !streaming ? (
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

				{visibleParts.map((part, idx) => {
					const globalIdx =
						expanded || !hasMore ? idx : totalSteps - AGENT_PREVIEW_STEPS + idx;

					if (part.type === "tool-call") {
						return (
							<AssistantToolCall
								key={globalIdx}
								toolName={(part.toolName as string) ?? "unknown"}
								args={(part.args as Record<string, unknown>) ?? {}}
								result={part.result}
							/>
						);
					}
					if (part.type === "text" && part.text) {
						return (
							<div
								key={globalIdx}
								className="text-[13px] leading-6 text-app-foreground-soft"
							>
								{(part.text as string).slice(0, 300)}
								{(part.text as string).length > 300 ? "\u2026" : ""}
							</div>
						);
					}
					if (part.type === "reasoning" && part.text) {
						return (
							<AssistantReasoning key={globalIdx} text={part.text as string} />
						);
					}
					return null;
				})}
			</div>
		</div>
	);
}

function CollapsedToolGroup({ group }: { group: CollapsedGroupPart }) {
	const icon =
		group.category === "search" ? (
			<Search className="size-3.5 text-app-info" strokeWidth={1.8} />
		) : (
			<FileText className="size-3.5 text-app-info" strokeWidth={1.8} />
		);

	return (
		<details className="group/collapse flex flex-col" open={false}>
			<summary className="flex max-w-full cursor-default items-center gap-1.5 py-0.5 text-[12px] text-app-muted [&::-webkit-details-marker]:hidden">
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
						className="size-2.5 transition-transform group-open/collapse:rotate-90"
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
			<div className="ml-5 flex flex-col gap-0.5 border-l border-app-border/30 pl-3 pt-1">
				{group.tools.map((tool, idx) => (
					<AssistantToolCall
						key={tool.toolCallId ?? `${tool.toolName}:${idx}`}
						toolName={tool.toolName}
						args={tool.args}
						result={tool.result}
					/>
				))}
			</div>
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
		return {
			action: "Run",
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
		const d = str(input.description) ?? str(input.prompt);
		return {
			action: name,
			icon: <Bot className="size-3.5 text-app-info" strokeWidth={1.8} />,
			detail: d ? truncate(d, 50) : undefined,
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
