import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowDown,
	ArrowUp,
	FileDiff,
	GitBranch,
	GitPullRequest,
	type LucideIcon,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import {
	LazyStreamdown,
	preloadStreamdown,
} from "@/components/streamdown-loader";
import {
	HoverCardContent,
	HoverCard as HoverCardRoot,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import type {
	ExtendedMessagePart,
	ThreadMessageLike,
	WorkspaceRow,
	WorkspaceSessionSummary,
} from "@/lib/api";
import {
	workspaceGitActionStatusQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import { useBusySessionIds } from "@/lib/session-run-state-context";
import {
	readSessionThread,
	sessionThreadCacheKey,
} from "@/lib/session-thread-cache";
import { summarizeToolCall } from "@/lib/tool-summary";
import { cn } from "@/lib/utils";
import { WorkspaceAvatar } from "./avatar";
import {
	WORKSPACE_DND_ACTIVE_ATTRIBUTE,
	WORKSPACE_DND_ACTIVE_CHANGE_EVENT,
} from "./dnd/shared";
import { humanizeBranch } from "./shared";

const STATUS_LABEL: Record<NonNullable<WorkspaceRow["status"]>, string> = {
	"in-progress": "In progress",
	review: "In review",
	done: "Done",
	backlog: "Backlog",
	canceled: "Canceled",
};

const STATUS_DOT_CLASS: Record<NonNullable<WorkspaceRow["status"]>, string> = {
	"in-progress": "bg-[var(--workspace-sidebar-status-progress)]",
	review: "bg-[var(--workspace-sidebar-status-review)]",
	done: "bg-[var(--workspace-sidebar-status-done)]",
	backlog: "bg-[var(--workspace-sidebar-status-backlog)]",
	canceled: "bg-[var(--workspace-sidebar-status-canceled)]",
};

function relativeTime(iso?: string | null): string | null {
	if (!iso) return null;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return formatDistanceToNow(date, { addSuffix: true });
}

/** Tiny icon + number chip for the top-right git status cluster. */
function CompactStat({
	icon: Icon,
	value,
	label,
	tone,
}: {
	icon: LucideIcon;
	value: string;
	label: string;
	tone: "warning" | "danger" | "default";
}) {
	const toneClass =
		tone === "warning"
			? "text-amber-500"
			: tone === "danger"
				? "text-destructive"
				: "text-foreground/75";
	return (
		<span
			className={cn("flex items-center gap-0.5", toneClass)}
			title={label}
			aria-label={label}
		>
			<Icon className="size-2.5 shrink-0" strokeWidth={2.2} />
			<span className="text-[10px] tabular-nums leading-none">{value}</span>
		</span>
	);
}

/** Compact git status: chips when dirty, single green icon when clean. */
function GitStats({ workspaceId }: { workspaceId: string }) {
	const { data, isLoading, isError } = useQuery(
		workspaceGitActionStatusQueryOptions(workspaceId),
	);
	if (isLoading || isError || !data) return null;

	const uncommitted = data.uncommittedCount;
	const behind = data.behindTargetCount;
	const ahead = data.aheadOfRemoteCount;
	const targetLabel = data.syncTargetBranch ?? "main";

	const chips: React.ReactNode[] = [];
	if (uncommitted > 0) {
		chips.push(
			<CompactStat
				key="uncommitted"
				icon={FileDiff}
				value={String(uncommitted)}
				label={`${uncommitted} uncommitted change${uncommitted === 1 ? "" : "s"}`}
				tone="warning"
			/>,
		);
	}
	if (behind > 0) {
		chips.push(
			<CompactStat
				key="behind"
				icon={ArrowDown}
				value={String(behind)}
				label={`${behind} commit${behind === 1 ? "" : "s"} behind ${targetLabel}`}
				tone="danger"
			/>,
		);
	}
	if (ahead > 0) {
		chips.push(
			<CompactStat
				key="ahead"
				icon={ArrowUp}
				value={String(ahead)}
				label={`${ahead} unpushed commit${ahead === 1 ? "" : "s"}`}
				tone="default"
			/>,
		);
	}

	if (chips.length === 0) {
		return (
			<span
				className="inline-flex shrink-0 items-center"
				title={`Branch up to date with ${targetLabel} · no uncommitted changes`}
				aria-label={`Branch up to date with ${targetLabel}`}
			>
				<GitBranch className="size-3 text-emerald-500/90" strokeWidth={2} />
			</span>
		);
	}

	return <span className="flex items-center gap-1.5">{chips}</span>;
}

/**
 * Pick the streaming session for the live preview: prefer non-hidden,
 * non-action sessions in `busySessionIds`; tiebreak on thread length;
 * fall back to `primarySessionId` if none are streaming.
 */
export function chooseLiveSessionId({
	workspaceSessions,
	busySessionIds,
	primarySessionId,
	queryClient,
}: {
	workspaceSessions: WorkspaceSessionSummary[] | undefined;
	busySessionIds: ReadonlySet<string>;
	primarySessionId: string | null | undefined;
	queryClient: ReturnType<typeof useQueryClient>;
}): string | null {
	const candidates = (workspaceSessions ?? []).filter(
		(session) =>
			!session.isHidden &&
			!session.actionKind &&
			busySessionIds.has(session.id),
	);

	if (candidates.length === 0) {
		return primarySessionId ?? null;
	}
	if (candidates.length === 1) {
		return candidates[0]?.id ?? primarySessionId ?? null;
	}

	let best = candidates[0];
	let bestCount = readSessionThread(queryClient, best?.id ?? "")?.length ?? 0;
	for (let i = 1; i < candidates.length; i++) {
		const candidate = candidates[i];
		if (!candidate) continue;
		const count = readSessionThread(queryClient, candidate.id)?.length ?? 0;
		if (count > bestCount) {
			best = candidate;
			bestCount = count;
		}
	}
	return best?.id ?? primarySessionId ?? null;
}

/** A single visible block in the live preview pane. */
type LiveBlock =
	| { kind: "markdown"; key: string; text: string; reasoning: boolean }
	| { kind: "tool"; key: string; label: string };

/** Cap markdown fed to Streamdown so long reasoning doesn't blow up parse time. */
export const LIVE_BLOCK_CHAR_BUDGET = 600;
export function truncateLiveText(text: string): string {
	if (text.length <= LIVE_BLOCK_CHAR_BUDGET) return text;
	return `…${text.slice(-LIVE_BLOCK_CHAR_BUDGET)}`;
}

/** Latest assistant message → ordered blocks (text/reasoning/tool/group). */
export function extractLiveActivity(
	thread: ThreadMessageLike[] | undefined,
): LiveBlock[] {
	if (!thread?.length) return [];
	let lastAssistant: ThreadMessageLike | undefined;
	for (let i = thread.length - 1; i >= 0; i--) {
		const message = thread[i];
		if (message?.role === "assistant") {
			lastAssistant = message;
			break;
		}
	}
	if (!lastAssistant) return [];

	const blocks: LiveBlock[] = [];
	for (const part of lastAssistant.content as ExtendedMessagePart[]) {
		switch (part.type) {
			case "text":
				if (part.text) {
					blocks.push({
						kind: "markdown",
						key: part.id,
						text: truncateLiveText(part.text),
						reasoning: false,
					});
				}
				break;
			case "reasoning":
				if (part.text) {
					blocks.push({
						kind: "markdown",
						key: part.id,
						text: truncateLiveText(part.text),
						reasoning: true,
					});
				}
				break;
			case "tool-call":
				blocks.push({
					kind: "tool",
					key: part.toolCallId,
					label: summarizeToolCall(part),
				});
				break;
			case "collapsed-group":
				if (part.summary) {
					blocks.push({
						kind: "tool",
						key: part.id,
						label: part.summary,
					});
				}
				break;
			default:
				break;
		}
	}
	return blocks;
}

/** Compact "stopwatch" string: `42s`, `2m 34s`, `1h 5m`. */
export function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
	const hr = Math.floor(totalMin / 60);
	const remMin = totalMin % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** "Running for X" timer next to the Helmor logo. Start time = last user
 *  message's optimistic createdAt (in thread cache the moment Send is hit). */
function StreamingElapsed({
	workspaceId,
	primarySessionId,
}: {
	workspaceId: string;
	primarySessionId: string | null | undefined;
}) {
	const queryClient = useQueryClient();
	const busySessionIds = useBusySessionIds();
	const { data: workspaceSessions } = useQuery(
		workspaceSessionsQueryOptions(workspaceId, { staleTime: 5_000 }),
	);

	const sessionId = chooseLiveSessionId({
		workspaceSessions,
		busySessionIds,
		primarySessionId,
		queryClient,
	});

	const { data: thread } = useQuery({
		queryKey: sessionThreadCacheKey(sessionId ?? "__none__"),
		queryFn: () =>
			sessionId ? (readSessionThread(queryClient, sessionId) ?? []) : [],
		enabled: Boolean(sessionId),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 30_000,
	});

	let startedAtIso: string | null = null;
	if (thread?.length) {
		for (let i = thread.length - 1; i >= 0; i--) {
			const message = thread[i];
			if (message?.role === "user" && message.createdAt) {
				startedAtIso = message.createdAt;
				break;
			}
		}
	}
	if (!startedAtIso && sessionId) {
		startedAtIso =
			workspaceSessions?.find((session) => session.id === sessionId)
				?.lastUserMessageAt ?? null;
	}

	// 1s tick to refresh the elapsed value; cleaned up on unmount.
	const [, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);

	if (!startedAtIso) return null;
	const startedAt = new Date(startedAtIso).getTime();
	if (Number.isNaN(startedAt)) return null;
	const elapsed = Date.now() - startedAt;
	if (elapsed < 0) return null;

	return (
		<span
			className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80"
			title={`Running for ${formatElapsed(elapsed)}`}
			aria-label={`Running for ${formatElapsed(elapsed)}`}
		>
			{formatElapsed(elapsed)}
		</span>
	);
}

/** Plain-text fallback for a markdown block while Streamdown lazy-loads. */
function MarkdownFallback({
	text,
	reasoning,
}: {
	text: string;
	reasoning: boolean;
}) {
	return (
		<div
			className={cn(
				"whitespace-pre-wrap break-words",
				reasoning ? "italic text-foreground/60" : "text-foreground/80",
			)}
		>
			{text}
		</div>
	);
}

/** Live preview pane: bottom-anchored blocks fading at the top. Mounted
 *  only when the HoverCard is open + `isSending`, so all queries here
 *  stay dormant in idle / unit-test scenarios. */
function LiveSessionPreview({
	workspaceId,
	primarySessionId,
}: {
	workspaceId: string;
	primarySessionId: string | null | undefined;
}) {
	const queryClient = useQueryClient();
	const busySessionIds = useBusySessionIds();

	// Pre-warm streamdown so Suspense rarely fires once the card opens.
	useEffect(() => {
		preloadStreamdown();
	}, []);

	// Override the global `staleTime: 0` so re-hover doesn't re-fire IPC.
	const { data: workspaceSessions } = useQuery(
		workspaceSessionsQueryOptions(workspaceId, { staleTime: 5_000 }),
	);

	const sessionId =
		chooseLiveSessionId({
			workspaceSessions,
			busySessionIds,
			primarySessionId,
			queryClient,
		}) ?? null;

	// Subscribe to the same cache key `use-streaming` writes deltas into.
	const { data: thread } = useQuery({
		queryKey: sessionThreadCacheKey(sessionId ?? "__none__"),
		queryFn: () =>
			sessionId ? (readSessionThread(queryClient, sessionId) ?? []) : [],
		enabled: Boolean(sessionId),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 30_000,
	});

	const blocks = useMemo(() => extractLiveActivity(thread), [thread]);

	if (blocks.length === 0) {
		return (
			<span className="text-[11px] italic text-muted-foreground/70">
				Thinking…
			</span>
		);
	}

	// `flex-col-reverse` + reversed array → newest at bottom, oldest clips at top.
	const reversed = [...blocks].reverse();

	return (
		<div
			className={cn(
				"flex max-h-32 flex-col-reverse gap-1.5 overflow-hidden text-[11px] leading-[1.4]",
				// Compact streamdown prose so default rhythm fits the small pane.
				"[&_p]:my-0 [&_pre]:my-1 [&_pre]:max-h-20 [&_pre]:overflow-hidden",
				"[&_ul]:my-1 [&_ol]:my-1 [&_h1]:text-[12px] [&_h2]:text-[12px] [&_h3]:text-[12px]",
				"[&_h1]:my-1 [&_h2]:my-1 [&_h3]:my-1 [&_code]:text-[10px]",
			)}
			style={{
				maskImage: "linear-gradient(to top, black 88%, transparent 100%)",
				WebkitMaskImage: "linear-gradient(to top, black 88%, transparent 100%)",
			}}
		>
			{reversed.map((block) => {
				if (block.kind === "tool") {
					return (
						<div
							key={block.key}
							className="flex items-baseline gap-1 font-mono text-[10px] text-muted-foreground"
						>
							<span className="text-muted-foreground/50">›</span>
							<span className="truncate">{block.label}</span>
						</div>
					);
				}
				return (
					<div
						key={block.key}
						className={cn(
							"break-words",
							block.reasoning && "italic text-foreground/60",
						)}
					>
						<Suspense
							fallback={
								<MarkdownFallback
									text={block.text}
									reasoning={block.reasoning}
								/>
							}
						>
							<LazyStreamdown>{block.text}</LazyStreamdown>
						</Suspense>
					</div>
				);
			})}
		</div>
	);
}

const HOVER_CARD_DIVIDER_GAP = 8;
const HOVER_CARD_DEFAULT_SIDE_OFFSET = 10;

export function WorkspaceHoverCard({
	row,
	isSending,
	children,
}: {
	row: WorkspaceRow;
	isSending?: boolean;
	children: React.ReactNode;
}) {
	// Measured on open so the card's left edge snaps to the sidebar divider.
	const [sideOffset, setSideOffset] = useState(HOVER_CARD_DEFAULT_SIDE_OFFSET);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const closeDuringDrag = () => {
			if (
				document.documentElement.getAttribute(
					WORKSPACE_DND_ACTIVE_ATTRIBUTE,
				) === "true"
			) {
				setOpen(false);
			}
		};

		window.addEventListener(WORKSPACE_DND_ACTIVE_CHANGE_EVENT, closeDuringDrag);
		closeDuringDrag();
		return () =>
			window.removeEventListener(
				WORKSPACE_DND_ACTIVE_CHANGE_EVENT,
				closeDuringDrag,
			);
	}, []);
	const handleOpenChange = useCallback(
		(open: boolean) => {
			if (
				open &&
				document.documentElement.getAttribute(
					WORKSPACE_DND_ACTIVE_ATTRIBUTE,
				) === "true"
			) {
				setOpen(false);
				return;
			}
			setOpen(open);
			if (!open) return;
			const rowEl = document.querySelector<HTMLElement>(
				`[data-workspace-row-id="${row.id}"]`,
			);
			if (!rowEl) return;
			const sidebarEl = rowEl.closest<HTMLElement>(
				"[data-helmor-sidebar-root]",
			);
			if (!sidebarEl) return;
			const rowRight = rowEl.getBoundingClientRect().right;
			const sidebarRight = sidebarEl.getBoundingClientRect().right;
			const offset = Math.max(
				HOVER_CARD_DIVIDER_GAP,
				sidebarRight - rowRight + HOVER_CARD_DIVIDER_GAP,
			);
			setSideOffset(offset);
		},
		[row.id],
	);

	const branch = row.branch ?? null;
	const repoLabel = row.repoName ?? row.directoryName ?? null;
	const subtitle = repoLabel
		? branch
			? `${repoLabel} › ${branch}`
			: repoLabel
		: branch;

	// Title fallback chain: PR title → primary session → active session → branch.
	const trimmedPrTitle = row.prTitle?.trim() || null;
	const primarySessionTitle =
		row.primarySessionTitle && row.primarySessionTitle !== "Untitled"
			? row.primarySessionTitle
			: null;
	const activeSessionTitleRaw =
		row.activeSessionTitle && row.activeSessionTitle !== "Untitled"
			? row.activeSessionTitle
			: null;
	const title =
		trimmedPrTitle ??
		primarySessionTitle ??
		activeSessionTitleRaw ??
		(branch ? humanizeBranch(branch) : row.title);

	const status = row.status ?? "in-progress";

	// "Last touched" prefers the most human-meaningful signal available.
	const lastActivityIso =
		row.lastUserMessageAt ?? row.updatedAt ?? row.createdAt ?? null;
	const lastActivity = relativeTime(lastActivityIso);
	const lastActivityLabel = row.lastUserMessageAt
		? "Last message"
		: row.updatedAt
			? "Last changed"
			: "Created";
	const createdAt = relativeTime(row.createdAt);
	const sessionCount = row.sessionCount ?? 0;

	return (
		<HoverCardRoot
			open={open}
			openDelay={400}
			closeDelay={80}
			onOpenChange={handleOpenChange}
		>
			<HoverCardTrigger asChild>{children}</HoverCardTrigger>
			<HoverCardContent
				side="right"
				align="start"
				sideOffset={sideOffset}
				className="w-72 p-3"
			>
				<div className="flex flex-col gap-2.5">
					{/* Header: repo › branch | git status + status dot. */}
					<div className="flex items-start justify-between gap-2">
						<div className="flex min-w-0 items-center gap-2">
							<WorkspaceAvatar
								repoIconSrc={row.repoIconSrc}
								repoInitials={row.repoInitials ?? row.avatar ?? null}
								repoName={row.repoName}
								title={title}
								className="size-4 rounded-[4px]"
							/>
							{subtitle ? (
								<span className="truncate text-[11px] text-muted-foreground">
									{subtitle}
								</span>
							) : null}
						</div>
						<div className="mt-0.5 flex shrink-0 items-center gap-2">
							<GitStats workspaceId={row.id} />
							<span
								aria-label={STATUS_LABEL[status]}
								title={STATUS_LABEL[status]}
								className={cn(
									"size-2 shrink-0 rounded-full",
									STATUS_DOT_CLASS[status],
								)}
							/>
						</div>
					</div>

					{/* Title row + Helmor logo + elapsed timer (when streaming). */}
					<div className="flex items-start gap-2">
						{isSending ? (
							<HelmorThinkingIndicator size={14} className="mt-0.5 shrink-0" />
						) : null}
						<div className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground line-clamp-2">
							{title}
						</div>
						{isSending ? (
							<StreamingElapsed
								workspaceId={row.id}
								primarySessionId={row.primarySessionId}
							/>
						) : null}
					</div>

					{isSending ? (
						<LiveSessionPreview
							workspaceId={row.id}
							primarySessionId={row.primarySessionId}
						/>
					) : null}

					{/* PR title (only when it isn't already the main title). */}
					{trimmedPrTitle && trimmedPrTitle !== title ? (
						<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
							<GitPullRequest className="size-3 shrink-0" strokeWidth={1.8} />
							<span className="truncate">{trimmedPrTitle}</span>
						</div>
					) : null}

					{/* Footer: session count on the left, last-activity timestamp on the right. */}
					<div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-muted-foreground/80">
						<div className="flex items-center gap-2.5">
							{sessionCount > 0 ? (
								<span className="tabular-nums">
									{sessionCount} {sessionCount === 1 ? "session" : "sessions"}
								</span>
							) : null}
						</div>
						{lastActivity ? (
							<span
								title={
									createdAt
										? `${lastActivityLabel} · created ${createdAt}`
										: lastActivityLabel
								}
							>
								{lastActivity}
							</span>
						) : null}
					</div>
				</div>
			</HoverCardContent>
		</HoverCardRoot>
	);
}
