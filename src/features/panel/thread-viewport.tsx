import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import {
	type ComponentType,
	createElement,
	type ReactNode,
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { Button } from "@/components/ui/button";
import type { ThreadMessageLike } from "@/lib/api";
import { HelmorProfiler } from "@/lib/dev-react-profiler";
import { useI18n } from "@/lib/i18n";
import { estimateThreadRowHeights } from "@/lib/message-layout-estimator";
import { measureSync } from "@/lib/perf-marks";
import { hasUnresolvedPlanReview } from "@/lib/plan-review";
import { expandSessionThread } from "@/lib/query-client";
import { useSessionThreadPagination } from "@/lib/session-thread-pagination";
import { useSettings } from "@/lib/settings";
import type { WorkspaceScriptType } from "@/lib/workspace-script-actions";
import { isShellResizing, onShellResize } from "@/shell/hooks/use-panels";
import {
	consumeAnchoredToggle,
	EmptyState,
	MemoConversationMessage,
	resetAnchoredToggle,
	UserMessageExpansionProvider,
} from "./message-components";
import { useEscapeBottomLock } from "./thread-viewport/use-escape-bottom-lock";
import { useStreamingIndicatorSync } from "./thread-viewport/use-streaming-indicator-sync";

export type PresentedSessionPane = {
	sessionId: string;
	messages: ThreadMessageLike[];
	sending: boolean;
	hasLoaded: boolean;
	presentationState: "presented";
};

type RenderedMessage = ThreadMessageLike;
type ThreadViewportSlot = ComponentType<Record<string, never>>;

// Persists streaming start times across component unmount/remount cycles
// (e.g. when switching sessions/workspaces and back).
const streamingStartTimes = new Map<string, number>();

const NON_VIRTUALIZED_THREAD_MESSAGE_LIMIT = 12;
const PROGRESSIVE_VIEWPORT_DEFAULT_HEIGHT = 900;
const PROGRESSIVE_VIEWPORT_HEADER_HEIGHT = 24;
const PROGRESSIVE_VIEWPORT_STREAMING_FOOTER_HEIGHT = 40;
const CONVERSATION_BOTTOM_SPACER_HEIGHT = 40;

export function resolveConversationRowHeight({
	estimatedHeight,
	measuredHeight,
}: {
	estimatedHeight: number;
	measuredHeight?: number;
}) {
	return measuredHeight ?? estimatedHeight;
}

// A row whose measured height changed only shifts the VISIBLE content when its
// top sits above the reading position (the viewport top), so only those rows
// need a scrollTop compensation. The streaming tail is never compensated — its
// growth is a pure bottom-extension that useStickToBottom already follows.
// Returns the pixels to add to the pending scroll adjustment (0 when none is
// due). The single source of truth shared by the inline (handleHeightChange) and
// batched (flush) commit paths, so the rule can never drift between them.
function aboveViewportCompensationDelta({
	rowTop,
	headerHeight,
	isStreaming,
	previousHeight,
	nextHeight,
	scrollTop,
}: {
	rowTop: number;
	headerHeight: number;
	isStreaming: boolean;
	previousHeight: number;
	nextHeight: number;
	scrollTop: number;
}): number {
	if (isStreaming || rowTop + headerHeight >= scrollTop) {
		return 0;
	}
	return nextHeight - previousHeight;
}

// Floor for the Tauri stable-bottom tail window. Kept small on purpose: near the
// bottom, visibleRows mounts this tail UNIONED with the regular scroll window, so
// a giant row sitting above the window stays unmounted and the switch commit only
// builds the visible region's DOM (the old 6x full-mount built thousands of
// off-screen nodes per switch — that was the bulk of the switch jank). The small
// mount is flash-free because the height estimator is now accurate (tab-normalized
// pretext measurement): the bottom anchor lands on the right row without mounting
// everything to force a measurement, and the union guarantees a scroll-up within
// the zone never exposes unmounted rows.
export function resolveStableBottomTailHeight(viewportHeight: number): number {
	const effectiveHeight =
		viewportHeight > 0 ? viewportHeight : PROGRESSIVE_VIEWPORT_DEFAULT_HEIGHT;
	return effectiveHeight * 1.5;
}

// How long after a session switch the viewport stays in its "initial settle"
// regime. Within it, measurement corrections commit at urgent priority and the
// true bottom is re-pinned pre-paint on every height wave (a late measure — e.g.
// a giant visible row landing its real height, or async fonts/highlighting): the
// deferred flip lets the estimate-positioned first layout and each correction
// wave PAINT as distinct frames (the old synchronous switch commit hid them),
// which reads as the list flashing through several regions. With an accurate
// estimator this is a no-op for light sessions and only fires for the rare giant
// visible row. Ends early on the first real user scroll.
export const INITIAL_SETTLE_WINDOW_MS = 1000;

// Measurement-correction commit priority: urgent while the initial settle is
// active (so the corrected layout paints first) and for the streaming row
// (whose height `useStickToBottom` must observe in step); transition
// otherwise, exactly as before.
export function shouldCommitMeasurementUrgently(
	isStreamingRow: boolean,
	initialSettleActive: boolean,
): boolean {
	return isStreamingRow || initialSettleActive;
}

export function ActiveThreadViewport({
	hasSession,
	workspaceName = null,
	pane,
	missingScriptTypes = [],
	onInitializeScript,
}: {
	hasSession: boolean;
	workspaceName?: string | null;
	pane: PresentedSessionPane;
	missingScriptTypes?: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
}) {
	const stackRef = useRef<HTMLDivElement | null>(null);
	const [widthBucket, setWidthBucket] = useState(0);
	const pendingBucketRef = useRef<number | null>(null);
	// 32px buckets so estimator/measureHeights caches only invalidate when
	// the drag crosses a bucket boundary.
	const paneWidth = widthBucket * 32;

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

		const computeBucket = (width: number) =>
			width > 0 ? Math.max(1, Math.round(width / 32)) : 0;

		// During drag the stack's clientWidth changes per frame via CSS var,
		// so the RO fires at 60Hz — but we don't want a React render each
		// time (text wrapping is already handled by the browser reflow).
		// Buffer to pending and flush when onShellResize(false) fires.
		const updateWidthBucket = () => {
			const width = stack.clientWidth;
			const next = computeBucket(width);
			if (isShellResizing()) {
				pendingBucketRef.current = next;
				return;
			}
			pendingBucketRef.current = null;
			setWidthBucket((current) => (current === next ? current : next));
		};

		updateWidthBucket();
		const observer = new ResizeObserver(() => {
			updateWidthBucket();
		});
		observer.observe(stack);

		const unsubscribe = onShellResize((active) => {
			if (active) return;
			const pending = pendingBucketRef.current;
			pendingBucketRef.current = null;
			if (pending === null) return;
			setWidthBucket((current) => (current === pending ? current : pending));
		});

		return () => {
			observer.disconnect();
			unsubscribe();
		};
	}, []);

	return (
		<div
			ref={stackRef}
			className="relative flex min-h-0 flex-1 overflow-hidden"
		>
			<div className="relative z-10 flex min-h-0 min-w-0 flex-1">
				<ChatThread
					hasSession={hasSession}
					workspaceName={workspaceName}
					messages={pane.messages}
					missingScriptTypes={missingScriptTypes}
					onInitializeScript={onInitializeScript}
					paneWidth={paneWidth}
					sessionId={pane.sessionId}
					sending={pane.sending}
				/>
			</div>
		</div>
	);
}

function ChatThread({
	messages,
	hasSession,
	workspaceName,
	missingScriptTypes,
	onInitializeScript,
	paneWidth,
	sessionId,
	sending,
}: {
	messages: ThreadMessageLike[];
	hasSession: boolean;
	workspaceName: string | null;
	missingScriptTypes: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
	paneWidth: number;
	sessionId: string;
	sending: boolean;
}) {
	const threadMessages = messages;
	const { settings } = useSettings();
	const queryClient = useQueryClient();
	const pagination = useSessionThreadPagination(sessionId);
	const usePlainThread =
		threadMessages.length <= NON_VIRTUALIZED_THREAD_MESSAGE_LIMIT;
	const hasStreamingMessage = threadMessages.some(
		(message) => message.streaming === true,
	);
	const pinTailRows = sending || hasStreamingMessage;
	const scrollParentRef = useRef<HTMLElement | null>(null);
	const { contentRef, scrollRef, scrollToBottom, stopScroll, isAtBottom } =
		useStickToBottom({
			initial: "instant",
			resize: "smooth",
		});
	const handleScrollRef = useCallback(
		(element: HTMLElement | null) => {
			scrollParentRef.current = element;
			scrollRef(element);
		},
		[scrollRef],
	);

	// "Load earlier" state. We capture the pre-expand scroll geometry so the
	// post-expand layout effect can offset `scrollTop` by the height of the
	// newly-prepended messages — that's what keeps the visible region from
	// jumping when older history slides in above the user's reading position.
	const [expanding, setExpanding] = useState(false);
	const pendingScrollAnchorRef = useRef<{
		prevScrollHeight: number;
		prevScrollTop: number;
	} | null>(null);

	const handleLoadEarlier = useCallback(async () => {
		if (expanding || !pagination.hasMore) return;
		const parent = scrollParentRef.current;
		if (parent) {
			pendingScrollAnchorRef.current = {
				prevScrollHeight: parent.scrollHeight,
				prevScrollTop: parent.scrollTop,
			};
		}
		setExpanding(true);
		try {
			await expandSessionThread(queryClient, sessionId);
		} catch (error) {
			pendingScrollAnchorRef.current = null;
			console.error("[thread-viewport] expand failed", error);
		} finally {
			setExpanding(false);
		}
	}, [expanding, pagination.hasMore, queryClient, sessionId]);

	// After expand: the new messages mounted, contentRef.scrollHeight grew.
	// Push scrollTop by exactly the delta so the user's visible message stays
	// pinned in place. `messages` is the layout-causing dep — once React
	// commits the new array, the layout effect runs synchronously before paint.
	useLayoutEffect(() => {
		const anchor = pendingScrollAnchorRef.current;
		if (!anchor) return;
		const parent = scrollParentRef.current;
		if (!parent) return;
		const delta = parent.scrollHeight - anchor.prevScrollHeight;
		if (delta > 0) {
			parent.scrollTop = anchor.prevScrollTop + delta;
		}
		pendingScrollAnchorRef.current = null;
	}, [messages]);

	// Discard a stale anchor when the user switches sessions mid-expand — the
	// remembered scrollHeight belongs to a different thread, so applying its
	// delta would mis-position the new thread.
	useEffect(() => {
		return () => {
			pendingScrollAnchorRef.current = null;
		};
	}, []);

	const loadEarlierBanner = pagination.hasMore ? (
		<LoadEarlierBanner loading={expanding} onClick={handleLoadEarlier} />
	) : null;
	// Track streaming start time per session so the timer survives session switches.
	if (sending && !streamingStartTimes.has(sessionId)) {
		streamingStartTimes.set(sessionId, Date.now());
	} else if (!sending) {
		streamingStartTimes.delete(sessionId);
	}
	const sendingStartTime = streamingStartTimes.get(sessionId) ?? 0;

	const previousSendingRef = useRef(sending);
	const sendingJustStarted = sending && !previousSendingRef.current;

	useEffect(() => {
		previousSendingRef.current = sending;
	}, [sending]);

	useEffect(() => {
		if (sendingJustStarted) {
			void scrollToBottom("instant");
		}
	}, [scrollToBottom, sendingJustStarted]);

	useLayoutEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const scrollParent = scrollParentRef.current;
		if (!scrollParent) {
			return;
		}

		if (usePlainThread) {
			scrollParent.scrollTop = scrollParent.scrollHeight;
			return;
		}

		void scrollToBottom("instant");
	}, [scrollToBottom, sessionId, usePlainThread]);

	// Editor close path: when chat container's `hidden` class is removed,
	// snap to bottom and pin for ~20 frames so the virtualized list's
	// progressive content growth doesn't show as a long smooth scroll. A
	// brief flash of top messages before the pin catches up is the accepted
	// tradeoff for not breaking streaming animations.
	useEffect(() => {
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const scrollParent = scrollParentRef.current;
		const chatContainer = scrollParent?.closest('[data-focus-scope="chat"]');
		if (!chatContainer || !scrollParent) {
			return;
		}
		let wasHidden = chatContainer.classList.contains("hidden");
		let rafId: number | null = null;
		const observer = new MutationObserver(() => {
			const isHidden = chatContainer.classList.contains("hidden");
			if (wasHidden && !isHidden) {
				void scrollToBottom("instant");
				let frames = 20;
				const pin = () => {
					scrollParent.scrollTop = scrollParent.scrollHeight;
					if (frames-- > 0) {
						rafId = requestAnimationFrame(pin);
					} else {
						rafId = null;
					}
				};
				pin();
			}
			wasHidden = isHidden;
		});
		observer.observe(chatContainer, {
			attributes: true,
			attributeFilter: ["class"],
		});
		return () => {
			observer.disconnect();
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
		};
	}, [scrollToBottom]);

	const itemContent = useCallback(
		(index: number, message: RenderedMessage) => {
			let previousAssistantMessage: RenderedMessage | null = null;
			for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
				const candidate = threadMessages[cursor];
				if (candidate?.role === "assistant") {
					previousAssistantMessage = candidate;
					break;
				}
			}

			return (
				<MemoConversationMessage
					message={message}
					previousAssistantMessage={previousAssistantMessage}
					sessionId={sessionId}
					itemIndex={index}
				/>
			);
		},
		[sessionId, threadMessages],
	);

	return (
		<HelmorProfiler id="ChatThread">
			<UserMessageExpansionProvider sessionId={sessionId}>
				<ConversationViewport
					contentRef={contentRef}
					data={threadMessages}
					fontSize={settings.chatFontSize}
					hasSession={hasSession}
					workspaceName={workspaceName}
					itemContent={itemContent}
					missingScriptTypes={missingScriptTypes}
					onInitializeScript={onInitializeScript}
					paneWidth={paneWidth}
					pinTailRows={pinTailRows}
					prologueSlot={loadEarlierBanner}
					scrollRef={handleScrollRef}
					sessionId={sessionId}
					sending={sending}
					sendingStartTime={sendingStartTime}
					stopScroll={stopScroll}
					usePlainThread={usePlainThread}
				>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						onClick={() => {
							scrollToBottom("instant");
						}}
						className={`conversation-scroll-button ${isAtBottom || sendingJustStarted ? "conversation-scroll-button-hidden" : ""}`}
						aria-label="scrollLatestMessage"
					>
						<ArrowDown className="size-4" strokeWidth={2} />
					</Button>
				</ConversationViewport>
			</UserMessageExpansionProvider>
		</HelmorProfiler>
	);
}

function ConversationViewport({
	children,
	contentRef,
	data,
	fontSize,
	hasSession,
	workspaceName,
	itemContent,
	missingScriptTypes,
	onInitializeScript,
	paneWidth,
	pinTailRows,
	prologueSlot,
	scrollRef,
	sessionId,
	sending,
	sendingStartTime,
	stopScroll,
	usePlainThread,
}: {
	children?: ReactNode;
	contentRef: React.RefCallback<HTMLElement>;
	data: RenderedMessage[];
	fontSize: number;
	hasSession: boolean;
	workspaceName: string | null;
	itemContent: (index: number, message: RenderedMessage) => ReactNode;
	missingScriptTypes: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
	paneWidth: number;
	pinTailRows: boolean;
	prologueSlot?: ReactNode;
	scrollRef: React.RefCallback<HTMLElement>;
	sessionId: string;
	sending: boolean;
	sendingStartTime: number;
	stopScroll: () => void;
	usePlainThread: boolean;
}) {
	const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);

	const viewportRef = useCallback(
		(element: HTMLDivElement | null) => {
			setScrollParent(element);
			scrollRef(element);
		},
		[scrollRef],
	);

	const Header: ThreadViewportSlot = ConversationHeaderSpacer;
	const planReviewActive = useMemo(() => hasUnresolvedPlanReview(data), [data]);
	const showStreamingFooter = sending && !planReviewActive;
	const streamingIndicatorStartTime = showStreamingFooter
		? sendingStartTime
		: undefined;
	const EmptyPlaceholder: ThreadViewportSlot = () => (
		<div className="flex min-h-full flex-1 items-center justify-center px-8">
			<EmptyState
				hasSession={hasSession}
				workspaceName={workspaceName}
				missingScriptTypes={missingScriptTypes}
				onInitializeScript={onInitializeScript}
			/>
		</div>
	);

	return (
		<div className="conversation-scroll-area relative min-h-0 flex-1 overflow-hidden">
			<div
				ref={viewportRef}
				className="conversation-scroll-viewport h-full w-full overflow-x-hidden overflow-y-auto"
			>
				{prologueSlot}
				{usePlainThread ? (
					<div ref={contentRef} className="flex min-h-full flex-col">
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
						{showStreamingFooter ? (
							<StreamingFooter startTime={sendingStartTime} />
						) : null}
						<ConversationBottomSpacer />
					</div>
				) : (
					<ProgressiveConversationViewport
						contentRef={contentRef}
						data={data}
						emptyPlaceholder={EmptyPlaceholder}
						fontSize={fontSize}
						header={Header}
						itemContent={itemContent}
						paneWidth={paneWidth}
						pinTailRows={pinTailRows}
						scrollParent={scrollParent}
						sessionId={sessionId}
						stopScroll={stopScroll}
						streamingIndicatorStartTime={streamingIndicatorStartTime}
					/>
				)}
			</div>
			{children}
		</div>
	);
}

/**
 * A single row in the virtualized progressive viewport. Two shapes:
 *
 *   - `message`: a real chat message, measured via `MeasuredConversationRow`.
 *   - `indicator`: the streaming logo + timer, rendered as a fixed-height
 *     pseudo row that lives in the same absolute-positioned coordinate
 *     system as messages. Keeping the indicator *inside* the rows container
 *     (instead of as its DOM sibling) means its `top` derives from the same
 *     `totalRowsHeight` math, so it can never land on top of the streaming
 *     row the way the old footer-sibling layout could.
 */
type ProgressiveViewportRow =
	| {
			kind: "message";
			key: string;
			index: number;
			top: number;
			height: number;
			message: RenderedMessage;
	  }
	| {
			kind: "indicator";
			key: string;
			index: number;
			top: number;
			height: number;
			startTime: number;
	  };

const STREAMING_INDICATOR_ROW_KEY = "__streaming_indicator__";

function ProgressiveConversationViewport({
	contentRef,
	data,
	emptyPlaceholder: EmptyPlaceholder,
	fontSize,
	header: Header,
	itemContent,
	paneWidth,
	pinTailRows,
	scrollParent,
	sessionId,
	stopScroll,
	streamingIndicatorStartTime,
}: {
	contentRef?: React.RefCallback<HTMLElement>;
	data: RenderedMessage[];
	emptyPlaceholder?: ThreadViewportSlot;
	fontSize: number;
	header?: ThreadViewportSlot;
	itemContent: (index: number, message: RenderedMessage) => ReactNode;
	paneWidth: number;
	pinTailRows: boolean;
	scrollParent: HTMLDivElement | null;
	sessionId: string;
	stopScroll: () => void;
	streamingIndicatorStartTime?: number;
}) {
	const { f } = useI18n();
	const [committedScrollState, setCommittedScrollState] = useState({
		scrollTop: 0,
		viewportHeight: 0,
	});
	const [measuredHeights, setMeasuredHeights] = useState<
		Record<string, number>
	>({});
	const initialScrollAppliedRef = useRef(false);
	const pendingScrollAdjustmentRef = useRef(0);
	const isUserScrollingRef = useRef(false);
	const scrollIdleTimerRef = useRef<number | null>(null);
	const deferredMeasuredHeightsRef = useRef<Record<string, number>>({});
	// Rows whose deferred height change came from an expand/collapse toggle: the
	// toggle's own click anchor already offset the scroller, so the flush must
	// NOT compensate them again (mirrors the inline `!anchoredToggle` guard).
	const deferredAnchoredKeysRef = useRef<Set<string>>(new Set());
	const hasUserScrolledRef = useRef(false);

	// DOM-driven sync for the streaming indicator pseudo row. See the effect
	// below and the `onDomMount` prop threaded into `MeasuredConversationRow`.
	const indicatorElRef = useRef<HTMLDivElement | null>(null);
	const [streamingRowEl, setStreamingRowEl] = useState<HTMLElement | null>(
		null,
	);
	const handleStreamingRowMount = useCallback((node: HTMLElement | null) => {
		setStreamingRowEl(node);
	}, []);

	// Reset only on sessionId change. Triggering on layoutCacheKey (which
	// included widthBucket) used to clear measuredHeights whenever a drag
	// crossed a 32px bound, causing visible row-height jumps and a full
	// remeasure. Within a session the message refs are stable, so the
	// ResizeObserver naturally reports new heights after the DOM reflows.
	const [lastSessionId, setLastSessionId] = useState(sessionId);
	const initialSettleAtRef = useRef<number | null>(null);
	if (initialSettleAtRef.current === null) {
		// Fresh mounts settle too (first open of a pane).
		initialSettleAtRef.current = performance.now();
	}
	if (lastSessionId !== sessionId) {
		setLastSessionId(sessionId);
		setCommittedScrollState({ scrollTop: 0, viewportHeight: 0 });
		setMeasuredHeights({});
		initialScrollAppliedRef.current = false;
		hasUserScrolledRef.current = false;
		isUserScrollingRef.current = false;
		initialSettleAtRef.current = performance.now();
		deferredMeasuredHeightsRef.current = {};
		deferredAnchoredKeysRef.current = new Set();
		// A mark from the previous session must not suppress a legit
		// compensation here (message ids could collide across panes).
		resetAnchoredToggle();
		if (scrollIdleTimerRef.current !== null) {
			window.clearTimeout(scrollIdleTimerRef.current);
			scrollIdleTimerRef.current = null;
		}
	}

	const { scrollTop, viewportHeight } = committedScrollState;
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
		const anchoredKeys = deferredAnchoredKeysRef.current;
		deferredAnchoredKeysRef.current = new Set();
		// Deferred corrections include rows ABOVE the reading position. Committing
		// their estimate→measured delta shifts every row below, so queue a scroll
		// compensation (via the shared aboveViewportCompensationDelta rule) that
		// holds the visible content when the flush lands — without it the position
		// drifts the instant a scroll-up settles. Anchored toggles are skipped:
		// their click anchor already moved the scroller.
		if (scrollParent) {
			const localHeaderHeight = Header ? PROGRESSIVE_VIEWPORT_HEADER_HEIGHT : 0;
			let delta = 0;
			for (const [rowKey, nextHeight] of entries) {
				if (anchoredKeys.has(rowKey)) {
					continue;
				}
				const row = rowsRef.current.find((entry) => entry.key === rowKey);
				if (row?.kind !== "message") {
					continue;
				}
				const previousHeight = measuredHeightsRef.current[rowKey] ?? row.height;
				delta += aboveViewportCompensationDelta({
					rowTop: row.top,
					headerHeight: localHeaderHeight,
					isStreaming: row.message.streaming === true,
					previousHeight,
					nextHeight,
					scrollTop: scrollParent.scrollTop,
				});
			}
			if (delta !== 0) {
				pendingScrollAdjustmentRef.current += delta;
			}
		}
		startTransition(() => {
			setMeasuredHeights((current) => ({
				...current,
				...Object.fromEntries(entries),
			}));
		});
	}, [Header, scrollParent]);

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
				// Asymmetric hysteresis: commit a scroll-up sooner (cheaper
				// threshold) so the tail union never exposes unmounted rows
				// mid-scroll; a scroll-down can wait for a larger delta.
				const commitThreshold = isScrollingUp
					? Math.max(24, Math.floor(buffer / 8))
					: Math.max(96, Math.floor(buffer / 3));
				if (scrollDelta < commitThreshold && viewportDelta < 8) {
					return current;
				}
				return {
					scrollTop: nextScrollTop,
					viewportHeight: nextViewportHeight,
				};
			});
			// Commit measured-height corrections WITHIN the scroll frame instead of
			// deferring every one to the 120ms post-stop idle. react-virtuoso and
			// TanStack Virtual measure synchronously as rows render; committing per
			// frame lets rows reach their real height while the motion still masks
			// the reflow, so when the scroll stops there is nothing left to "pop".
			// The idle flush in scheduleCommit stays as the final catch.
			flushDeferredMeasuredHeights();
		};

		const scheduleCommit = () => {
			if (rafId !== null) {
				return;
			}
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
	}, [flushDeferredMeasuredHeights, scrollParent]);

	// Flush row heights deferred during shell resize once the drag ends.
	useEffect(() => {
		return onShellResize((active) => {
			if (!active) flushDeferredMeasuredHeights();
		});
	}, [flushDeferredMeasuredHeights]);

	useEscapeBottomLock({ scrollParent, stopScroll, hasUserScrolledRef });

	const estimatedHeights = useMemo(
		() => estimateThreadRowHeights(data, { fontSize, paneWidth }),
		[data, fontSize, paneWidth],
	);
	const rows = useMemo<ProgressiveViewportRow[]>(
		() =>
			measureSync(
				"viewport:rows",
				() => {
					const result: ProgressiveViewportRow[] = [];
					let top = 0;
					data.forEach((message, index) => {
						const key = message.id ?? `${message.role}:${index}`;
						const estimatedHeight = estimatedHeights[index] ?? 72;
						const measuredHeight = measuredHeights[key];
						const height = resolveConversationRowHeight({
							estimatedHeight,
							measuredHeight,
						});
						result.push({
							height,
							index,
							key,
							kind: "message",
							message,
							top,
						});
						top += height;
					});
					if (streamingIndicatorStartTime !== undefined) {
						const indicatorHeight =
							PROGRESSIVE_VIEWPORT_STREAMING_FOOTER_HEIGHT;
						result.push({
							height: indicatorHeight,
							index: data.length,
							key: STREAMING_INDICATOR_ROW_KEY,
							kind: "indicator",
							startTime: streamingIndicatorStartTime,
							top,
						});
					}
					return result;
				},
				{
					count:
						data.length + (streamingIndicatorStartTime !== undefined ? 1 : 0),
				},
			),
		[data, estimatedHeights, measuredHeights, streamingIndicatorStartTime],
	);
	const totalRowsHeight =
		rows.length > 0
			? rows[rows.length - 1]!.top + rows[rows.length - 1]!.height
			: 0;
	// Fallback `top` for the streaming indicator while the streaming row's
	// DOM node isn't mounted yet (e.g. request just sent, assistant hasn't
	// emitted yet). Once the streaming row mounts, the DOM-driven effect
	// below takes over and this value is ignored.
	const lastRow = rows[rows.length - 1];
	const indicatorFallbackTop =
		lastRow?.kind === "indicator" ? lastRow.top : undefined;

	// DOM-driven indicator position sync.
	//
	// The indicator pseudo row is the streaming logo + timer; it lives in
	// the same absolute-positioned coordinate system as message rows.
	// We own its `top` exclusively from here — the JSX for the indicator
	// deliberately does *not* pass `top`, otherwise every React re-render
	// would race with this effect and overwrite the synced value with the
	// state-driven one (producing the "overlap flashes back in then fixes
	// itself" effect).
	//
	// When the streaming row's DOM node is mounted we pin the indicator to
	// `streaming-row.offsetTop + offsetHeight` via a ResizeObserver. The RO
	// callback runs inside the same frame *before* paint, and we only ever
	// write a single `style.top`, so this is O(1) regardless of thread
	// length. When the streaming row isn't mounted yet (request sent but
	// assistant hasn't started emitting), we fall back to the state-driven
	// row.top so the indicator doesn't collapse to y=0.
	useStreamingIndicatorSync({
		indicatorElRef,
		streamingRowEl,
		indicatorFallbackTop,
	});
	const headerHeight = Header ? PROGRESSIVE_VIEWPORT_HEADER_HEIGHT : 0;
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
	// The stable-bottom zone (4x) stays WIDER than the tail floor (1.5x) so that
	// on scroll-up within the zone the scroll-window clamp — not the tail — is the
	// binding constraint in the union below (locked by the scroll-up union test).
	const tauriStableBottomZoneHeight = effectiveViewportHeight * 4;
	const tauriStableBottomTailHeight =
		resolveStableBottomTailHeight(viewportHeight);
	const visibleRows = useMemo(
		() =>
			measureSync(
				"viewport:visible-rows",
				() => {
					// Two exclusive mount modes keep the "hold the bottom" paths from
					// overlapping: near the bottom (within the zone) → bottom tail UNION
					// the scroll window; scrolled far up → the regular window plus the
					// streaming pinTailRows append. (The settle pin is orthogonal — it
					// moves scrollTop, not which rows mount.)
					if (distanceFromBottom <= tauriStableBottomZoneHeight) {
						// Bottom-anchored tail (cheap: a giant row sitting above the
						// window stays unmounted) UNION the regular scroll window, so a
						// scroll-up within the stable-bottom zone can never expose
						// unmounted rows — the tail alone is narrower than the zone.
						const tailWindowTop = Math.min(
							Math.max(0, totalRowsHeight - tauriStableBottomTailHeight),
							windowTop,
						);
						return rows.filter((row) => row.top + row.height >= tailWindowTop);
					}

					const inWindow = rows.filter((row) => {
						const rowBottom = row.top + row.height;
						// Tall rows (multi-viewport reasoning blocks) keep a
						// mount zone scaled to their own height so scrolling
						// past and back doesn't tear down the smoothing-hook
						// progress and streamdown's internal block state.
						const localExpand = row.height > buffer ? row.height - buffer : 0;
						const localTop = windowTop - localExpand;
						const localBottom = windowBottom + localExpand;
						return rowBottom >= localTop && row.top <= localBottom;
					});
					if (!pinTailRows || rows.length === 0) {
						return inWindow;
					}

					const tailStartIndex = Math.max(0, rows.length - 2);
					const lastVisibleIndex =
						inWindow.length > 0 ? inWindow[inWindow.length - 1]!.index : -1;
					if (lastVisibleIndex >= rows.length - 1) {
						return inWindow;
					}
					const result = inWindow.slice();
					const appendStart = Math.max(tailStartIndex, lastVisibleIndex + 1);
					for (let index = appendStart; index < rows.length; index += 1) {
						result.push(rows[index]!);
					}
					return result;
				},
				{ totalRows: rows.length },
			),
		[
			buffer,
			distanceFromBottom,
			effectiveViewportHeight,
			pinTailRows,
			rows,
			tauriStableBottomTailHeight,
			totalRowsHeight,
			windowBottom,
			windowTop,
		],
	);
	// Note: the streaming footer no longer lives as a sibling of the rows
	// container. When present it is an in-list `indicator` row whose height
	// is already included in `totalRowsHeight`, so we don't re-add it here.
	const totalContentHeight =
		headerHeight + totalRowsHeight + CONVERSATION_BOTTOM_SPACER_HEIGHT;
	const rowsRef = useRef(rows);
	useLayoutEffect(() => {
		rowsRef.current = rows;
	}, [rows]);

	useLayoutEffect(() => {
		if (!scrollParent || initialScrollAppliedRef.current) {
			return;
		}

		const clientHeight = scrollParent.clientHeight;
		const targetScrollTop = Math.max(0, totalContentHeight - clientHeight);
		scrollParent.scrollTop = targetScrollTop;
		setCommittedScrollState({
			scrollTop: targetScrollTop,
			viewportHeight: clientHeight,
		});
		initialScrollAppliedRef.current = true;
	}, [scrollParent, totalContentHeight]);

	const isInitialSettleActive = useCallback(
		() =>
			!hasUserScrolledRef.current &&
			performance.now() - (initialSettleAtRef.current ?? 0) <
				INITIAL_SETTLE_WINDOW_MS,
		[],
	);

	useLayoutEffect(() => {
		if (!scrollParent) {
			return;
		}

		// Initial-settle regime: hold the TRUE bottom through the expansion
		// and measurement waves before anything paints. Pinned absolutely so
		// the per-row adjustments below can't fight it. The scrollHeight
		// guard skips environments without layout (jsdom), where the "true
		// bottom" would read as 0 and fight the initial-scroll effect.
		if (isInitialSettleActive() && scrollParent.scrollHeight > 0) {
			const target = Math.max(
				0,
				scrollParent.scrollHeight - scrollParent.clientHeight,
			);
			if (Math.abs(scrollParent.scrollTop - target) > 1) {
				scrollParent.scrollTop = target;
			}
			// The absolute settle pin supersedes any per-row delta queued by
			// handleHeightChange — drop it so the two paths can't double-apply.
			pendingScrollAdjustmentRef.current = 0;
			return;
		}

		if (pendingScrollAdjustmentRef.current === 0) {
			return;
		}
		// Apply regardless of hasUserScrolled: the queued delta is exactly the
		// height correction of rows ABOVE the reading position (historical async
		// content, or the deferred estimate→measured flush after a scroll-up
		// settles), so adding it to scrollTop holds the visible content in place.
		// Gating this on !hasUserScrolled WAS the scroll-up drift — once the user
		// had scrolled, corrections committed uncompensated and the content jumped
		// the instant the scroll ended.
		scrollParent.scrollTop += pendingScrollAdjustmentRef.current;
		pendingScrollAdjustmentRef.current = 0;
		// visibleRows (not rows): the expansion wave widens the window without
		// touching the row model, and the pin must land in that very commit.
	}, [isInitialSettleActive, scrollParent, totalContentHeight, visibleRows]);

	const handleHeightChange = useCallback(
		(rowKey: string, nextHeight: number) => {
			const roundedHeight = Math.max(24, Math.ceil(nextHeight));
			const row = rowsRef.current.find((entry) => entry.key === rowKey);
			// Only message rows flow through here. The indicator pseudo row
			// has a fixed height and does not use `MeasuredConversationRow`.
			if (row?.kind !== "message") {
				return;
			}

			const previousHeight = measuredHeightsRef.current[rowKey] ?? row.height;
			if (Math.abs(previousHeight - roundedHeight) < 2) {
				return;
			}

			// One-shot: the expand/collapse anchor already offset the scroller
			// for this row's height change — compensating below too would
			// double-apply the delta.
			const anchoredToggle = consumeAnchoredToggle(row.message.id);

			// Defer during shell resize too: each visible row's RO fires per frame
			// as the main pane width changes, and committing all of them would
			// thrash React. Same buffered path as user-scrolling.
			if (
				(hasUserScrolledRef.current && isUserScrollingRef.current) ||
				isShellResizing()
			) {
				deferredMeasuredHeightsRef.current[rowKey] = roundedHeight;
				if (anchoredToggle) {
					deferredAnchoredKeysRef.current.add(rowKey);
				}
				return;
			}

			const isStreamingRow = row.message.streaming === true;

			// The streaming row's height changes are pure bottom-extensions:
			// only its own offsetBottom grows, there are no rows below it to
			// be pushed down, and the user's reading position is unaffected.
			// `useStickToBottom` already follows scrollHeight growth via its
			// smooth animation, so adjusting scrollTop here on top of that
			// double-pushes past maxTop, gets clamped, and desyncs the
			// library's internal state from the DOM — producing a
			// one-line-high up/down jitter that is very visible in fast
			// streams once the streaming row itself has grown past the
			// scrollTop. Skip the adjust for the streaming row; keep it for
			// historical rows (image loads, code highlighting, late font
			// swaps) where it is genuinely needed.
			if (!anchoredToggle && scrollParent) {
				pendingScrollAdjustmentRef.current += aboveViewportCompensationDelta({
					rowTop: row.top,
					headerHeight,
					isStreaming: isStreamingRow,
					previousHeight,
					nextHeight: roundedHeight,
					scrollTop: scrollParent.scrollTop,
				});
			}

			const commit = () =>
				setMeasuredHeights((current) => ({
					...current,
					[rowKey]: roundedHeight,
				}));
			// Streaming rows commit at default priority (no transition) so
			// the outer div height that `useStickToBottom` observes stays in
			// step with reality and auto-scroll can keep following. Indicator
			// positioning is handled by a separate DOM-driven sync below, so
			// we don't need `flushSync` here — which in long threads becomes
			// O(n) and re-introduces stuttering near the end of a long
			// streamed reply.
			if (
				shouldCommitMeasurementUrgently(isStreamingRow, isInitialSettleActive())
			) {
				commit();
			} else {
				startTransition(commit);
			}
		},
		[headerHeight, isInitialSettleActive, scrollParent],
	);

	if (data.length === 0) {
		return (
			<div ref={contentRef} className="flex min-h-full flex-col">
				{Header ? createElement(Header) : null}
				{EmptyPlaceholder ? createElement(EmptyPlaceholder) : null}
				<ConversationBottomSpacer />
			</div>
		);
	}

	return (
		<div ref={contentRef} style={{ minHeight: totalContentHeight }}>
			{Header ? createElement(Header) : null}
			<div
				aria-label={f("panelConversationRowsForSession", { sessionId })}
				style={{ height: totalRowsHeight, position: "relative" }}
			>
				{visibleRows.map((row) => {
					if (row.kind === "indicator") {
						return (
							<div
								ref={indicatorElRef}
								key={row.key}
								style={{
									height: row.height,
									left: 0,
									position: "absolute",
									right: 0,
									// `top` is intentionally omitted: it is owned by the
									// DOM-sync useLayoutEffect above. Including it here
									// would cause every React re-render to overwrite the
									// synced value.
								}}
							>
								<StreamingFooter startTime={row.startTime} />
							</div>
						);
					}
					const isStreamingMessage = row.message.streaming === true;
					return (
						<MeasuredConversationRow
							key={row.key}
							onDomMount={
								isStreamingMessage ? handleStreamingRowMount : undefined
							}
							onHeightChange={handleHeightChange}
							rowKey={row.key}
							top={row.top}
						>
							{itemContent(row.index, row.message)}
						</MeasuredConversationRow>
					);
				})}
			</div>
			<ConversationBottomSpacer />
		</div>
	);
}

function MeasuredConversationRow({
	children,
	onDomMount,
	onHeightChange,
	rowKey,
	top,
}: {
	children: ReactNode;
	/**
	 * Optional callback fired with the row's outer DOM node when it mounts
	 * (and `null` when it unmounts). Used by the parent to wire a
	 * ResizeObserver directly onto the streaming row's DOM for zero-latency
	 * indicator position sync — see the indicator-sync effect in
	 * `ProgressiveConversationViewport`.
	 */
	onDomMount?: (node: HTMLElement | null) => void;
	onHeightChange: (rowKey: string, nextHeight: number) => void;
	rowKey: string;
	top: number;
}) {
	const rowRef = useRef<HTMLDivElement | null>(null);
	const setRowRef = useCallback(
		(node: HTMLDivElement | null) => {
			rowRef.current = node;
			onDomMount?.(node);
		},
		[onDomMount],
	);

	useLayoutEffect(() => {
		const node = rowRef.current;
		if (!node) {
			return;
		}

		onHeightChange(rowKey, node.offsetHeight);

		if (typeof ResizeObserver === "undefined") {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const box = entry.borderBoxSize?.[0];
				const height = box ? box.blockSize : entry.contentRect.height;
				if (height < 1) {
					continue;
				}
				onHeightChange(rowKey, height);
			}
		});
		observer.observe(node);
		return () => {
			observer.disconnect();
		};
	}, [onHeightChange, rowKey]);

	return (
		<div
			ref={setRowRef}
			style={{
				...conversationRowIsolationStyle,
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

const conversationRowIsolationStyle = {
	contain: "paint",
	isolation: "isolate",
} as const;

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

export function ConversationColdPlaceholder() {
	return <div className="flex min-h-0 flex-1" aria-hidden="true" />;
}

function ConversationHeaderSpacer() {
	return <div className="h-6 shrink-0" />;
}

/**
 * Affordance shown at the top of the scroll viewport whenever older
 * messages exist beyond the loaded window. Self-triggers via an
 * IntersectionObserver as the user scrolls up to it; clicking is the
 * fallback for keyboard / pointer users.
 */
function LoadEarlierBanner({
	loading,
	onClick,
}: {
	loading: boolean;
	onClick: () => void;
}) {
	const { t } = useI18n();
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const onClickRef = useRef(onClick);
	useEffect(() => {
		onClickRef.current = onClick;
	}, [onClick]);

	// Auto-trigger when the banner enters the viewport. We re-create the
	// observer each render cycle that toggles `loading` so we don't fire
	// again while an expand is in flight.
	useEffect(() => {
		const node = sentinelRef.current;
		if (!node || loading) return;
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					onClickRef.current();
				}
			},
			{ root: null, rootMargin: "100px 0px 0px 0px", threshold: 0 },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [loading]);

	return (
		<div
			ref={sentinelRef}
			className="flex shrink-0 items-center justify-center py-2"
		>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={loading}
				onClick={onClick}
				className="h-7 gap-1.5 px-2.5 text-small text-muted-foreground hover:text-foreground"
			>
				{loading ? (
					<Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
				) : (
					<ArrowUp className="size-3.5" strokeWidth={2} />
				)}
				<span>
					{loading
						? t("loadingEarlierMessages")
						: t("panelLoadEarlierMessages")}
				</span>
			</Button>
		</div>
	);
}

function ConversationBottomSpacer() {
	return (
		<div
			className="shrink-0"
			style={{ height: `${CONVERSATION_BOTTOM_SPACER_HEIGHT}px` }}
		/>
	);
}

function StreamingFooter({ startTime }: { startTime: number }) {
	// Derive elapsed from a ticking clock so a startTime change (e.g. workspace
	// switch) reflects immediately instead of waiting for the next tick.
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(intervalId);
	}, []);

	const elapsed = Math.max(0, Math.floor((now - startTime) / 1000));

	const display =
		elapsed < 60
			? `${elapsed}s`
			: `${Math.floor(elapsed / 60)}m ${(elapsed % 60)
					.toString()
					.padStart(2, "0")}s`;

	return (
		<div
			data-testid="streaming-footer"
			className="flex items-center gap-1.5 px-5 py-3 text-small tabular-nums text-muted-foreground"
		>
			<HelmorLogoAnimated size={14} className="opacity-80" />
			{display}
		</div>
	);
}
