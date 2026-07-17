import {
	Ban,
	Bot,
	CheckCircle2,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Clock3,
	FileText,
	Loader2,
	PauseCircle,
	XCircle,
} from "lucide-react";
import {
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { CARD_BAR_CHROME } from "@/features/composer/composer-top-bars";
import { formatTokens } from "@/features/composer/context-usage-ring/parse";
import { formatWorkflowDuration } from "@/features/panel/message-components/content-parts";
import type { TaskState, TaskStatus, ToolCallPart } from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { publishShellEvent } from "@/shell/event-bus";
import {
	type BackgroundFallbackItem,
	useBackgroundTasks,
} from "./use-background-tasks";

type StatusMeta = {
	labelKey: string;
	tone: string;
	Icon: typeof Loader2;
};

const STATUS_META: Record<TaskStatus, StatusMeta> = {
	pending: {
		labelKey: "taskPanelStatusPending",
		tone: "text-muted-foreground",
		Icon: Clock3,
	},
	running: {
		labelKey: "taskPanelStatusRunning",
		tone: "text-status-info",
		Icon: Loader2,
	},
	completed: {
		labelKey: "taskPanelStatusCompleted",
		tone: "text-status-success",
		Icon: CheckCircle2,
	},
	failed: {
		labelKey: "taskPanelStatusFailed",
		tone: "text-status-danger",
		Icon: XCircle,
	},
	cancelled: {
		labelKey: "taskPanelStatusCancelled",
		tone: "text-status-danger",
		Icon: Ban,
	},
	killed: {
		labelKey: "taskPanelStatusKilled",
		tone: "text-status-danger",
		Icon: Ban,
	},
	paused: {
		labelKey: "taskPanelStatusPaused",
		tone: "text-status-warning",
		Icon: PauseCircle,
	},
};

function isSubagentTask(task: TaskState): boolean {
	// The Claude SDK emits task_type "local_agent" for subagents (older
	// builds used "subagent"); local_bash marks background terminal tasks.
	return (
		Boolean(task.subagentType) ||
		task.taskType === "local_agent" ||
		task.taskType === "subagent"
	);
}

function taskTitle(task: TaskState, fallback: string): string {
	const raw =
		task.description?.trim() ||
		task.subagentType?.trim() ||
		task.taskType?.trim() ||
		fallback;
	return raw;
}

/** One compact `a · b · c` metrics line, matching the workflow panel style. */
function taskMeta(task: TaskState, typeLabel: string): string {
	return [
		typeLabel,
		task.subagentType ?? null,
		typeof task.usage?.totalTokens === "number"
			? `${formatTokens(task.usage.totalTokens)} tokens`
			: null,
		typeof task.usage?.toolUses === "number"
			? `${task.usage.toolUses} tool${task.usage.toolUses === 1 ? "" : "s"}`
			: null,
		typeof task.usage?.durationMs === "number"
			? formatWorkflowDuration(task.usage.durationMs)
			: null,
	]
		.filter((x): x is string => x !== null)
		.join(" · ");
}

const ROW = "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left";

type PanelItem =
	| { kind: "task"; id: string; task: TaskState; tool: ToolCallPart | null }
	| { kind: "fallback"; id: string; fallback: BackgroundFallbackItem };

/** Tool output → display text, mirroring the chat tool-row's stringify. */
function toolResultText(tool: ToolCallPart | null): string | null {
	if (!tool || tool.result == null) return null;
	const text =
		typeof tool.result === "string"
			? tool.result
			: JSON.stringify(tool.result, null, 2);
	return text.trim().length > 0 ? text : null;
}

function toolArgString(tool: ToolCallPart | null, key: string): string | null {
	const value = tool?.args?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Composer-anchored background-task pill + drill-down card, the sibling of
 * `WorkflowProgressPanel`. The pill appears whenever the session has tasks
 * (or, with none, running terminal processes); clicking it opens a card with
 * Level 0 = the task list and Level 1 = one task's detail (metrics, command,
 * summary, error, and a clickable output file that opens in the editor).
 */
export function TaskProgressPanel({
	sessionId,
	workspaceId,
}: {
	sessionId: string | null;
	workspaceId?: string | null;
}) {
	const { f, t } = useI18n();
	const data = useBackgroundTasks({ sessionId, workspaceId });
	const panelRef = useRef<HTMLDivElement>(null);
	const scrollContentRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef<HTMLButtonElement>(null);
	const [collapsed, setCollapsed] = useState(true);
	// Detail selection is id-addressed (not index-addressed): if the selected
	// task disappears from a shrinking/reordering snapshot, the panel falls
	// back to the list instead of silently showing a different task.
	const [openId, setOpenId] = useState<string | null>(null);
	const [highlight, setHighlight] = useState(0);
	const [height, setHeight] = useState<number | null>(null);

	const items = useMemo<PanelItem[]>(() => {
		if (data.mode === "tasks") {
			return data.tasks.map(({ state, tool }) => ({
				kind: "task" as const,
				id: state.id,
				task: state,
				tool,
			}));
		}
		if (data.mode === "fallbacks") {
			return data.fallbacks.map((fallback) => ({
				kind: "fallback",
				id: fallback.id,
				fallback,
			}));
		}
		return [];
	}, [data]);

	const runningCount = useMemo(
		() =>
			data.mode === "tasks"
				? data.tasks.filter(
						({ state }) =>
							state.status === "running" || state.status === "pending",
					).length
				: data.fallbacks.length,
		[data],
	);

	// Reset navigation when the feed empties (e.g. session switch).
	useEffect(() => {
		if (items.length === 0) {
			setCollapsed(true);
			setOpenId(null);
			setHighlight(0);
		}
	}, [items.length]);

	const detailIndex =
		openId === null ? -1 : items.findIndex((item) => item.id === openId);
	const detail = detailIndex >= 0 ? items[detailIndex] : undefined;
	const level: 0 | 1 = detail ? 1 : 0;
	const listLen = level === 0 ? items.length : 0;
	const hi = Math.min(highlight, Math.max(0, listLen - 1));

	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [hi]);

	// Same explicit-height animation pattern as the workflow panel: measure the
	// natural content height (capped at 55vh) so level changes animate smoothly.
	const heightSig = collapsed
		? "collapsed"
		: level === 0
			? `0:${items.length}`
			: `1:${openId}:${detail?.kind === "task" ? (detail.task.summary?.length ?? 0) : 0}`;
	useLayoutEffect(() => {
		if (items.length === 0) return;
		const panel = panelRef.current;
		if (!panel) return;
		const measure = () => {
			const prev = panel.style.height;
			panel.style.height = "auto";
			// +1 absorbs fractional content heights that `scrollHeight` truncates —
			// without it the inner scroll region shows a 1px phantom scrollbar.
			const natural = panel.scrollHeight + 1;
			panel.style.height = prev;
			// Tighter cap than the workflow panel: the list is resident, so it
			// should never dominate the pane even fully expanded.
			const cap = Math.min(320, Math.round(window.innerHeight * 0.4));
			setHeight(Math.min(natural, cap));
		};
		measure();
		const target = scrollContentRef.current;
		const ro = target ? new ResizeObserver(measure) : null;
		if (target && ro) ro.observe(target);
		window.addEventListener("resize", measure);
		return () => {
			ro?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [items.length, heightSig]);

	if (items.length === 0) return null;

	const refocus = () => panelRef.current?.focus();
	const cycle = (delta: 1 | -1) => {
		if (listLen === 0) return;
		setHighlight((((hi + delta) % listLen) + listLen) % listLen);
	};
	const descend = () => {
		if (level === 0 && items.length > 0) {
			setOpenId(items[hi]?.id ?? null);
		}
	};
	const ascend = () => {
		if (level === 1) {
			setHighlight(Math.max(detailIndex, 0));
			setOpenId(null);
		}
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				cycle(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				cycle(-1);
				break;
			case "ArrowRight":
			case "Enter":
				event.preventDefault();
				descend();
				break;
			case "ArrowLeft":
				event.preventDefault();
				ascend();
				break;
			case "Escape":
				event.preventDefault();
				if (level === 1) {
					ascend();
				} else {
					setCollapsed(true);
				}
				break;
		}
	};

	const detailTitle =
		detail?.kind === "task"
			? taskTitle(detail.task, t("taskPanelUntitledTask"))
			: (detail?.fallback.title ?? "");

	// Collapsed strip key info: the task in flight (or the most recent one),
	// done/total progress, and the aggregate status.
	const currentItem =
		items.find(
			(item) => item.kind === "task" && item.task.status === "running",
		) ??
		items.find((item) => item.kind === "fallback") ??
		items[items.length - 1];
	const currentTitle =
		currentItem?.kind === "task"
			? taskTitle(currentItem.task, t("taskPanelUntitledTask"))
			: (currentItem?.fallback.title ?? "");
	const doneCount = items.length - runningCount;
	// Idle aggregate must not paint failures green: surface the worst
	// terminal status (failed > killed > cancelled > completed).
	const worstTerminal: TaskStatus = items.some(
		(item) => item.kind === "task" && item.task.status === "failed",
	)
		? "failed"
		: items.some(
					(item) => item.kind === "task" && item.task.status === "killed",
				)
			? "killed"
			: items.some(
						(item) => item.kind === "task" && item.task.status === "cancelled",
					)
				? "cancelled"
				: "completed";
	const idleStatus = STATUS_META[worstTerminal];

	// One root element for both states so the explicit-height transition
	// animates the collapse/expand toggle itself, not just level changes.
	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			onKeyDown={collapsed ? undefined : onKeyDown}
			style={{
				height: height != null ? `${height}px` : undefined,
				transition: "height 360ms cubic-bezier(0.22, 1, 0.36, 1)",
			}}
			// Flat chrome matching the composer beneath it (border/70 + bg-sidebar,
			// no shadow); rounded-lg reads calmer than xl at this strip height.
			className={cn(CARD_BAR_CHROME, "mt-1 mb-1")}
		>
			{collapsed ? (
				<button
					type="button"
					onClick={() => setCollapsed(false)}
					aria-expanded={false}
					aria-label={t("taskPanelTitle")}
					className="flex h-9 w-full shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-left hover:bg-accent/40"
				>
					{runningCount > 0 ? (
						<Loader2
							className="size-3.5 shrink-0 animate-spin text-status-info"
							strokeWidth={1.8}
						/>
					) : (
						<Bot
							className="size-3.5 shrink-0 text-muted-foreground"
							strokeWidth={1.8}
						/>
					)}
					{runningCount > 0 ? (
						<ShimmerText className="min-w-0 truncate text-ui" durationMs={2400}>
							{currentTitle}
						</ShimmerText>
					) : (
						<span className="min-w-0 truncate text-ui text-muted-foreground">
							{currentTitle}
						</span>
					)}
					<span className="ml-auto shrink-0 text-mini tabular-nums text-muted-foreground/60">
						{doneCount}/{items.length}
					</span>
					<span
						className={cn(
							"shrink-0 text-mini",
							runningCount > 0 ? "text-status-info" : idleStatus.tone,
						)}
					>
						{runningCount > 0
							? t("taskPanelStatusRunning")
							: t(idleStatus.labelKey)}
					</span>
					<ChevronDown
						className="size-3.5 shrink-0 text-muted-foreground/40"
						strokeWidth={1.8}
					/>
				</button>
			) : (
				<div className="flex min-h-0 flex-1 flex-col p-2.5">
					{/* pl-[7px] lines the header icon up with the item rows' status
					    icons (rows are px-2, nudged 1px left per design review). */}
					<div className="mb-1.5 flex items-center gap-[5px] pr-0.5 pl-[7px]">
						{level === 0 ? (
							<>
								<Bot
									className="size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.8}
								/>
								<span className="text-mini font-medium uppercase tracking-[0.06em] text-muted-foreground">
									<I18nText
										source={
											data.mode === "tasks"
												? "taskPanelTitle"
												: "taskPanelFallbackHeading"
										}
									/>
								</span>
							</>
						) : (
							<button
								type="button"
								onClick={() => {
									ascend();
									refocus();
								}}
								className="flex min-w-0 cursor-pointer items-center gap-1 rounded text-mini font-medium text-muted-foreground hover:text-foreground"
							>
								<ChevronLeft className="size-3.5 shrink-0" strokeWidth={1.8} />
								<span className="truncate uppercase tracking-[0.06em]">
									{detailTitle}
								</span>
							</button>
						)}
						<span className="ml-auto shrink-0 text-mini text-muted-foreground/60">
							{runningCount > 0
								? f("taskPanelPillRunning", { count: runningCount })
								: f("taskPanelPillDone", { count: items.length })}
						</span>
						<button
							type="button"
							onClick={() => setCollapsed(true)}
							aria-label={t("taskPanelCollapse")}
							className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<ChevronUp className="size-3.5" strokeWidth={1.8} />
						</button>
					</div>

					<div className="flex min-h-0 flex-1 flex-col">
						{level === 0 ? (
							// max-h caps the list at ~4 rows; anything beyond scrolls.
							<div className="max-h-[8.5rem] min-h-0 flex-1 overflow-y-auto">
								<div ref={scrollContentRef} className="flex flex-col gap-0.5">
									{items.map((item, index) => (
										<TaskRow
											key={item.id}
											item={item}
											highlighted={index === hi}
											rowRef={index === hi ? activeRef : undefined}
											onHover={() => setHighlight(index)}
											onClick={() => {
												setOpenId(item.id);
												refocus();
											}}
										/>
									))}
								</div>
							</div>
						) : detail ? (
							<TaskDetail item={detail} scrollContentRef={scrollContentRef} />
						) : null}
					</div>
				</div>
			)}
		</div>
	);
}

function TaskRow({
	item,
	highlighted,
	rowRef,
	onHover,
	onClick,
}: {
	item: PanelItem;
	highlighted: boolean;
	rowRef?: React.Ref<HTMLButtonElement>;
	onHover: () => void;
	onClick: () => void;
}) {
	const { t } = useI18n();
	if (item.kind === "fallback") {
		return (
			<button
				type="button"
				ref={rowRef}
				onMouseEnter={onHover}
				onClick={onClick}
				className={cn(ROW, "cursor-pointer text-ui", highlighted && "bg-muted")}
			>
				<Loader2
					className="size-3 shrink-0 animate-spin text-status-info"
					strokeWidth={1.8}
				/>
				<span className="shrink-0 truncate font-medium text-foreground">
					{item.fallback.title}
				</span>
				<span className="ml-auto shrink-0 truncate text-mini text-muted-foreground/60">
					{t(item.fallback.typeKey)}
				</span>
				<ChevronRight
					className="size-3.5 shrink-0 text-muted-foreground/40"
					strokeWidth={1.8}
				/>
			</button>
		);
	}
	const task = item.task;
	const status = STATUS_META[task.status];
	const StatusIcon = status.Icon;
	return (
		<button
			type="button"
			ref={rowRef}
			onMouseEnter={onHover}
			onClick={onClick}
			data-testid={`task-panel-status-${task.status}`}
			className={cn(ROW, "cursor-pointer text-ui", highlighted && "bg-muted")}
		>
			<StatusIcon
				className={cn(
					"size-3 shrink-0",
					task.status === "running" && "animate-spin",
					status.tone,
				)}
				strokeWidth={1.8}
			/>
			<span className="min-w-0 truncate font-medium text-foreground">
				{taskTitle(task, t("taskPanelUntitledTask"))}
			</span>
			<span className={cn("shrink-0 text-mini", status.tone)}>
				{t(status.labelKey)}
			</span>
			<span className="ml-auto shrink-0 truncate text-mini text-muted-foreground/60">
				{typeof task.usage?.durationMs === "number"
					? formatWorkflowDuration(task.usage.durationMs)
					: null}
			</span>
			<ChevronRight
				className="size-3.5 shrink-0 text-muted-foreground/40"
				strokeWidth={1.8}
			/>
		</button>
	);
}

function TaskDetail({
	item,
	scrollContentRef,
}: {
	item: PanelItem;
	scrollContentRef: React.RefObject<HTMLDivElement | null>;
}) {
	const { t } = useI18n();
	if (item.kind === "fallback") {
		const fallback = item.fallback;
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-1.5 px-1 py-0.5">
				<div className="flex items-center gap-1.5">
					<Loader2
						className="size-3.5 shrink-0 animate-spin text-status-info"
						strokeWidth={1.8}
					/>
					<span className="truncate font-medium text-foreground">
						{fallback.title}
					</span>
					<span className="ml-auto shrink-0 text-mini text-muted-foreground/60">
						{t(fallback.typeKey)}
					</span>
				</div>
				{fallback.command ? <CommandBlock command={fallback.command} /> : null}
			</div>
		);
	}
	const task = item.task;
	const status = STATUS_META[task.status];
	const StatusIcon = status.Icon;
	const subagent = isSubagentTask(task);
	const typeLabel = subagent
		? t("taskPanelTypeSubagent")
		: t("taskPanelTypeBackgroundTerminal");
	const meta = taskMeta(task, typeLabel);
	// Terminal tasks ride on a Bash tool call: `args.command` is the command,
	// `result` its output. Subagent tasks ride on a Task tool call:
	// `args.prompt` is the dispatched instruction, `result` the final report
	// (only shown when the aggregated summary is absent).
	const command = subagent ? null : toolArgString(item.tool, "command");
	const prompt = subagent ? toolArgString(item.tool, "prompt") : null;
	const output = toolResultText(item.tool);
	const body = task.summary ?? (subagent ? output : null);
	const terminalOutput = subagent ? null : output;
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1.5 px-1 py-0.5">
			<div className="flex items-center gap-1.5">
				<StatusIcon
					className={cn(
						"size-3.5 shrink-0",
						task.status === "running" && "animate-spin",
						status.tone,
					)}
					strokeWidth={1.8}
				/>
				<span className="truncate font-medium text-foreground">
					{taskTitle(task, t("taskPanelUntitledTask"))}
				</span>
				<span className={cn("ml-auto shrink-0 text-mini", status.tone)}>
					{t(status.labelKey)}
				</span>
			</div>
			{meta ? (
				<div className="text-mini text-muted-foreground/60">{meta}</div>
			) : null}
			{command ? <CommandBlock command={command} /> : null}
			{prompt ? (
				<div className="max-h-20 overflow-y-auto rounded-md border-l-2 border-border/60 bg-muted/30 px-2.5 py-1.5 text-small leading-5 text-muted-foreground">
					{prompt}
				</div>
			) : null}
			{task.error ? (
				<div className="text-small text-status-danger">{task.error}</div>
			) : null}
			{task.outputFile ? (
				<button
					type="button"
					onClick={() =>
						publishShellEvent({
							type: "open-file-in-editor",
							path: task.outputFile!,
						})
					}
					className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-small text-muted-foreground hover:text-foreground"
				>
					<FileText className="size-3.5 shrink-0" strokeWidth={1.8} />
					<span className="truncate underline decoration-border underline-offset-2">
						{task.outputFile}
					</span>
				</button>
			) : null}
			{terminalOutput ? (
				<div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-muted/50 px-2.5 py-2">
					<div ref={scrollContentRef}>
						<pre className="whitespace-pre-wrap break-words font-mono text-small leading-5 text-foreground">
							{terminalOutput.length > 4000
								? `…${terminalOutput.slice(-4000)}`
								: terminalOutput}
						</pre>
					</div>
				</div>
			) : body ? (
				<div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-muted/50 px-2.5 py-2 text-foreground">
					<div ref={scrollContentRef}>
						<Suspense
							fallback={
								<pre className="whitespace-pre-wrap break-words text-ui leading-6 text-foreground">
									{body}
								</pre>
							}
						>
							<LazyStreamdown className="conversation-streamdown" mode="static">
								{body}
							</LazyStreamdown>
						</Suspense>
					</div>
				</div>
			) : null}
		</div>
	);
}

function CommandBlock({ command }: { command: string }) {
	return (
		<pre className="max-h-20 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 px-2.5 py-2 font-mono text-small leading-5 text-foreground">
			{command}
		</pre>
	);
}
