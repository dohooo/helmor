import { ArrowDown } from "lucide-react";
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
import { estimateThreadRowHeights } from "@/lib/message-layout-estimator";
import { measureSync } from "@/lib/perf-marks";
import { hasUnresolvedPlanReview } from "@/lib/plan-review";
import { useSettings } from "@/lib/settings";
import type { WorkspaceScriptType } from "@/lib/workspace-script-actions";
import { EmptyState, MemoConversationMessage } from "./message-components";

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

const CHAT_LAYOUT_CACHE_VERSION = "chat-layout-v1";
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

export function ActiveThreadViewport({
	hasSession,
	pane,
	missingScriptTypes = [],
	onInitializeScript,
}: {
	hasSession: boolean;
	pane: PresentedSessionPane;
	missingScriptTypes?: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
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
			<div className="relative z-10 flex min-h-0 min-w-0 flex-1">
				<ChatThread
					hasSession={hasSession}
					layoutCacheKey={getSessionLayoutCacheKey(pane.sessionId, widthBucket)}
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
	layoutCacheKey,
	messages,
	hasSession,
	missingScriptTypes,
	onInitializeScript,
	paneWidth,
	sessionId,
	sending,
}: {
	layoutCacheKey: string;
	messages: ThreadMessageLike[];
	hasSession: boolean;
	missingScriptTypes: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
	paneWidth: number;
	sessionId: string;
	sending: boolean;
}) {
	const threadMessages = messages;
	const { settings } = useSettings();
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
			<ConversationViewport
				contentRef={contentRef}
				data={threadMessages}
				fontSize={settings.fontSize}
				hasSession={hasSession}
				itemContent={itemContent}
				layoutCacheKey={layoutCacheKey}
				missingScriptTypes={missingScriptTypes}
				onInitializeScript={onInitializeScript}
				paneWidth={paneWidth}
				pinTailRows={pinTailRows}
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
					aria-label="Scroll to latest message"
				>
					<ArrowDown className="size-4" strokeWidth={2} />
				</Button>
			</ConversationViewport>
		</HelmorProfiler>
	);
}

function ConversationViewport({
	children,
	contentRef,
	data,
	fontSize,
	hasSession,
	itemContent,
	layoutCacheKey,
	missingScriptTypes,
	onInitializeScript,
	paneWidth,
	pinTailRows,
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
	itemContent: (index: number, message: RenderedMessage) => ReactNode;
	layoutCacheKey: string;
	missingScriptTypes: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
	paneWidth: number;
	pinTailRows: boolean;
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
						layoutCacheKey={layoutCacheKey}
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
	layoutCacheKey,
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
	layoutCacheKey: string;
	paneWidth: number;
	pinTailRows: boolean;
	scrollParent: HTMLDivElement | null;
	sessionId: string;
	stopScroll: () => void;
	streamingIndicatorStartTime?: number;
}) {
	const isTauri = true;
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
	}, [flushDeferredMeasuredHeights, isTauri, scrollParent]);

	useEffect(() => {
		if (!scrollParent || typeof window === "undefined") {
			return;
		}
		const escapeBottomLock = () => {
			hasUserScrolledRef.current = true;
			stopScroll();
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
		};
	}, [scrollParent, stopScroll]);

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
	useLayoutEffect(() => {
		const indicator = indicatorElRef.current;
		if (!indicator) {
			return;
		}
		if (streamingRowEl) {
			const sync = () => {
				indicator.style.top = `${
					streamingRowEl.offsetTop + streamingRowEl.offsetHeight
				}px`;
			};
			sync();
			if (typeof ResizeObserver === "undefined") {
				return;
			}
			const observer = new ResizeObserver(sync);
			observer.observe(streamingRowEl);
			return () => observer.disconnect();
		}
		if (indicatorFallbackTop !== undefined) {
			indicator.style.top = `${indicatorFallbackTop}px`;
		}
	}, [streamingRowEl, indicatorFallbackTop]);
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
			isTauri,
			pinTailRows,
			rows,
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

	useLayoutEffect(() => {
		if (!scrollParent || pendingScrollAdjustmentRef.current === 0) {
			return;
		}

		if (!hasUserScrolledRef.current) {
			scrollParent.scrollTop += pendingScrollAdjustmentRef.current;
		}
		pendingScrollAdjustmentRef.current = 0;
	}, [rows, scrollParent]);

	const handleHeightChange = useCallback(
		(rowKey: string, nextHeight: number) => {
			const roundedHeight = Math.max(24, Math.ceil(nextHeight));
			const row = rowsRef.current.find((entry) => entry.key === rowKey);
			// Only message rows flow through here. The indicator pseudo row
			// has a fixed height and does not use `MeasuredConversationRow`.
			if (!row || row.kind !== "message") {
				return;
			}

			const previousHeight = measuredHeightsRef.current[rowKey] ?? row.height;
			if (Math.abs(previousHeight - roundedHeight) < 2) {
				return;
			}

			if (isTauri && hasUserScrolledRef.current && isUserScrollingRef.current) {
				deferredMeasuredHeightsRef.current[rowKey] = roundedHeight;
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
			if (
				!isStreamingRow &&
				scrollParent &&
				row.top + headerHeight < scrollParent.scrollTop
			) {
				pendingScrollAdjustmentRef.current += roundedHeight - previousHeight;
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
			if (isStreamingRow) {
				commit();
			} else {
				startTransition(commit);
			}
		},
		[headerHeight, isTauri, scrollParent],
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
				aria-label={`Conversation rows for session ${sessionId}`}
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
							disableContentVisibility={isTauri}
							onDomMount={
								isStreamingMessage ? handleStreamingRowMount : undefined
							}
							onHeightChange={handleHeightChange}
							rowKey={row.key}
							top={row.top}
							estimatedHeight={row.height}
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
	disableContentVisibility,
	estimatedHeight,
	onDomMount,
	onHeightChange,
	rowKey,
	top,
}: {
	children: ReactNode;
	disableContentVisibility: boolean;
	estimatedHeight: number;
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

	const intrinsicSize = `auto ${Math.max(24, Math.round(estimatedHeight))}px`;
	return (
		<div
			ref={setRowRef}
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

const conversationRowIsolationStyle = {
	contain: "paint",
	isolation: "isolate",
} as const;

const measuredRowIsolationStyle = {
	...conversationRowIsolationStyle,
	contentVisibility: "auto",
	containIntrinsicSize: "auto 100px",
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

function getSessionLayoutCacheKey(sessionId: string, widthBucket: number) {
	return [CHAT_LAYOUT_CACHE_VERSION, sessionId, String(widthBucket)].join(":");
}

export function ConversationColdPlaceholder() {
	return <div className="flex min-h-0 flex-1" aria-hidden="true" />;
}

function ConversationHeaderSpacer() {
	return <div className="h-6 shrink-0" />;
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
	const [elapsed, setElapsed] = useState(() =>
		Math.floor((Date.now() - startTime) / 1000),
	);

	useEffect(() => {
		const intervalId = window.setInterval(() => {
			setElapsed(Math.floor((Date.now() - startTime) / 1000));
		}, 1000);
		return () => window.clearInterval(intervalId);
	}, [startTime]);

	const display =
		elapsed < 60
			? `${elapsed}s`
			: `${Math.floor(elapsed / 60)}m ${(elapsed % 60)
					.toString()
					.padStart(2, "0")}s`;

	return (
		<div
			data-testid="streaming-footer"
			className="flex items-center gap-1.5 px-5 py-3 text-[12px] tabular-nums text-muted-foreground"
		>
			<HelmorLogoAnimated size={14} className="opacity-80" />
			{display}
		</div>
	);
}
