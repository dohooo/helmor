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
const PROGRESSIVE_VIEWPORT_FOOTER_HEIGHT = 20;

export function ActiveThreadViewport({
	hasSession,
	pane,
}: {
	hasSession: boolean;
	pane: PresentedSessionPane;
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
	const Footer: ThreadViewportSlot =
		sending && !planReviewActive
			? () => <StreamingFooter startTime={sendingStartTime} />
			: ConversationFooterSpacer;
	const EmptyPlaceholder: ThreadViewportSlot = () => (
		<div className="flex min-h-full flex-1 items-center justify-center px-8">
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
						{Footer ? createElement(Footer) : null}
					</div>
				) : (
					<ProgressiveConversationViewport
						contentRef={contentRef}
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
			if (!row) {
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
			<div ref={contentRef} className="flex min-h-full flex-col">
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

function ConversationFooterSpacer() {
	return <div className="h-5 shrink-0" />;
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
		<div className="flex items-center gap-1.5 px-5 py-3 text-[12px] tabular-nums text-muted-foreground">
			<HelmorLogoAnimated size={14} className="opacity-80" />
			{display}
		</div>
	);
}
