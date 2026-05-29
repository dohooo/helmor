import { useQuery } from "@tanstack/react-query";
import {
	Check,
	ChevronLeft,
	ChevronRight,
	CircleDot,
	Workflow,
	X,
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
import { formatTokens } from "@/features/composer/context-usage-ring/parse";
import { formatWorkflowDuration } from "@/features/panel/message-components/content-parts";
import { ShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { WorkflowAgentRow, WorkflowPart } from "@/lib/api";
import { sessionThreadMessagesQueryOptions } from "@/lib/query-client";
import { cn } from "@/lib/utils";

/**
 * Derive this session's workflow widgets from the rendered thread cache. The
 * same cache the conversation reads, so it updates live as task_* events land
 * during a turn. (Workflows that outlive the turn stop updating — the agent
 * subprocess is torn down on turn end — so this reflects last-known state.)
 */
function useSessionWorkflows(sessionId: string | null): WorkflowPart[] {
	const { data } = useQuery({
		...sessionThreadMessagesQueryOptions(sessionId ?? ""),
		enabled: !!sessionId,
	});
	return useMemo(() => {
		const out: WorkflowPart[] = [];
		for (const msg of data ?? []) {
			if (msg.role !== "assistant") continue;
			for (const part of msg.content ?? []) {
				if (part.type === "workflow") out.push(part);
			}
		}
		return out;
	}, [data]);
}

const WORKFLOW_STATUS_LABEL: Record<WorkflowPart["status"], string> = {
	running: "running",
	completed: "done",
	failed: "failed",
	stopped: "stopped",
};

function statusTone(status: WorkflowPart["status"]): string {
	return status === "failed"
		? "text-destructive"
		: status === "completed"
			? "text-chart-2"
			: "text-muted-foreground";
}

function runMeta(part: WorkflowPart): string {
	const agents = part.agents ?? [];
	return [
		agents.length > 0
			? `${agents.length} agent${agents.length === 1 ? "" : "s"}`
			: null,
		typeof part.totalTokens === "number"
			? `${formatTokens(part.totalTokens)} tokens`
			: null,
		typeof part.durationMs === "number"
			? formatWorkflowDuration(part.durationMs)
			: null,
	]
		.filter((x): x is string => x !== null)
		.join(" · ");
}

/**
 * Flatten the run's agents into a phase-grouped render list. The SDK only
 * carries `phaseIndex`/`phaseTitle` back-refs on each agent (no standalone
 * phase tree), so we group by first-appearance phase order; agents without a
 * phase fall into one untitled group. `flat` is the navigable agent order
 * (the keyboard highlight + L2 selection index into it).
 */
type DetailRow =
	| { kind: "phase"; title: string }
	| { kind: "agent"; agent: WorkflowAgentRow; index: number };

function buildDetailRows(agents: WorkflowAgentRow[]): {
	rows: DetailRow[];
	flat: WorkflowAgentRow[];
} {
	const order: (number | "none")[] = [];
	const byKey = new Map<
		number | "none",
		{ title: string | null; items: WorkflowAgentRow[] }
	>();
	for (const agent of agents) {
		const key =
			typeof agent.phaseIndex === "number" ? agent.phaseIndex : "none";
		let group = byKey.get(key);
		if (!group) {
			group = { title: agent.phaseTitle ?? null, items: [] };
			byKey.set(key, group);
			order.push(key);
		}
		group.items.push(agent);
	}
	const rows: DetailRow[] = [];
	const flat: WorkflowAgentRow[] = [];
	for (const key of order) {
		const group = byKey.get(key)!;
		if (group.title) rows.push({ kind: "phase", title: group.title });
		for (const agent of group.items) {
			rows.push({ kind: "agent", agent, index: flat.length });
			flat.push(agent);
		}
	}
	return { rows, flat };
}

function agentMeta(agent: WorkflowAgentRow): string {
	return [
		agent.model ?? null,
		typeof agent.tokens === "number"
			? `${formatTokens(agent.tokens)} tokens`
			: null,
		typeof agent.toolCalls === "number"
			? `${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`
			: null,
		typeof agent.durationMs === "number"
			? formatWorkflowDuration(agent.durationMs)
			: null,
	]
		.filter((x): x is string => x !== null)
		.join(" · ");
}

const ROW = "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left";

/**
 * Independent, composer-anchored view of this conversation's workflow runs,
 * opened via the `/workflows` client command. A keyboard-navigable drill-down:
 * Level 0 lists the runs, Level 1 shows one run's agents grouped by phase, and
 * Level 2 shows a single agent's metrics + result preview (the SDK's deepest
 * leaf — full per-agent output never reaches the event stream). Up/Down move,
 * Right/Enter descend, Left ascends, Esc closes.
 */
export function WorkflowProgressPanel({
	sessionId,
	open,
	onClose,
}: {
	sessionId: string | null;
	open: boolean;
	onClose: () => void;
}) {
	const workflows = useSessionWorkflows(sessionId);
	const panelRef = useRef<HTMLDivElement>(null);
	const headerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef<HTMLButtonElement>(null);
	const [level, setLevel] = useState<0 | 1 | 2>(0);
	const [runIndex, setRunIndex] = useState(0);
	const [agentIndex, setAgentIndex] = useState(0);
	const [highlight, setHighlight] = useState(0);
	// Explicit pixel height so the SAME card element animates smoothly between
	// levels (a content-driven `auto`/`max-height` can't transition). Capped so
	// a long result never makes the card overrun the viewport — it scrolls.
	const [height, setHeight] = useState<number | null>(null);

	const run =
		workflows[Math.min(runIndex, Math.max(0, workflows.length - 1))] ?? null;
	const { rows, flat } = useMemo(
		() => buildDetailRows(run?.agents ?? []),
		[run],
	);

	const listLen =
		level === 0 ? workflows.length : level === 1 ? flat.length : 0;
	const hi = Math.min(highlight, Math.max(0, listLen - 1));

	const detailAgent =
		level === 2
			? flat[Math.min(agentIndex, Math.max(0, flat.length - 1))]
			: undefined;

	// Reset to the run list + take focus whenever the panel opens.
	useEffect(() => {
		if (!open) return;
		setLevel(0);
		setRunIndex(0);
		setAgentIndex(0);
		setHighlight(0);
		const id = requestAnimationFrame(() => panelRef.current?.focus());
		return () => cancelAnimationFrame(id);
	}, [open]);

	// Esc closes from anywhere (fallback for when focus has drifted off the
	// panel); the panel's own onKeyDown handles it while focused.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	// Keep the highlighted row in view as the selection moves.
	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [hi, level]);

	// Drive the card's explicit height from its natural content height, capped
	// at 55vh. A ResizeObserver re-measures on every content change — level
	// switches AND the lazy markdown finishing its first render — so the height
	// always eases to the right size and the body scrolls past the cap.
	// Signature forces a synchronous re-measure the instant the level changes.
	const heightSig =
		level === 0
			? `0:${workflows.length}`
			: level === 1
				? `1:${runIndex}:${flat.length}`
				: `2:${agentIndex}:${detailAgent?.resultPreview?.length ?? 0}`;
	useLayoutEffect(() => {
		if (!open) return;
		const header = headerRef.current;
		const content = contentRef.current;
		if (!header || !content) return;
		const measure = () => {
			// 28 ≈ panel padding (20) + header→body gap (6) + border (2).
			const natural = header.offsetHeight + content.offsetHeight + 28;
			const cap = Math.round(window.innerHeight * 0.55);
			setHeight(Math.min(natural, cap));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(content);
		window.addEventListener("resize", measure);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [open, heightSig]);

	if (!open) return null;

	const refocus = () => panelRef.current?.focus();
	const cycle = (delta: 1 | -1) => {
		if (listLen === 0) return;
		setHighlight((((hi + delta) % listLen) + listLen) % listLen);
	};
	const descend = () => {
		if (level === 0 && workflows.length > 0) {
			setRunIndex(hi);
			setLevel(1);
			setHighlight(0);
		} else if (level === 1 && flat.length > 0) {
			setAgentIndex(hi);
			setLevel(2);
		}
	};
	const ascend = () => {
		if (level === 2) {
			setLevel(1);
			setHighlight(agentIndex);
		} else if (level === 1) {
			setLevel(0);
			setHighlight(runIndex);
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
				onClose();
				break;
		}
	};

	const headerTitle =
		level === 0
			? "Workflows"
			: level === 1
				? (run?.name ?? "Workflow")
				: (flat[Math.min(agentIndex, Math.max(0, flat.length - 1))]?.label ??
					"Agent");

	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			style={{
				height: height != null ? `${height}px` : undefined,
				// Ease-out (fast → slow) so the resize feels like it settles.
				transition: "height 360ms cubic-bezier(0.22, 1, 0.36, 1)",
			}}
			className="pointer-events-auto mb-3 flex w-full flex-col overflow-hidden rounded-xl border border-border/40 bg-popover p-2.5 shadow-sm outline-none"
		>
			<div ref={headerRef} className="mb-1.5 flex items-center gap-1.5 px-0.5">
				{level === 0 ? (
					<>
						<Workflow
							className="size-3.5 shrink-0 text-muted-foreground"
							strokeWidth={1.8}
						/>
						<span className="text-mini font-medium uppercase tracking-[0.06em] text-muted-foreground">
							Workflows
						</span>
					</>
				) : (
					<button
						type="button"
						onClick={() => {
							ascend();
							refocus();
						}}
						className="flex min-w-0 items-center gap-1 rounded text-mini font-medium text-muted-foreground hover:text-foreground"
					>
						<ChevronLeft className="size-3.5 shrink-0" strokeWidth={1.8} />
						<span className="truncate uppercase tracking-[0.06em]">
							{headerTitle}
						</span>
					</button>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					<ShortcutDisplay hotkey="Escape" />
					<button
						type="button"
						onClick={onClose}
						aria-label="Close workflows"
						className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<X className="size-3.5" strokeWidth={1.8} />
					</button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div ref={contentRef}>
					{level === 0 ? (
						workflows.length === 0 ? (
							<p className="px-1 py-2 text-ui leading-6 text-muted-foreground">
								No workflows in this conversation yet. They appear here when the
								agent runs a dynamic workflow.
							</p>
						) : (
							<div className="flex flex-col gap-0.5">
								{workflows.map((part, index) => (
									<button
										key={part.id}
										type="button"
										ref={index === hi ? activeRef : undefined}
										onMouseEnter={() => setHighlight(index)}
										onClick={() => {
											setRunIndex(index);
											setLevel(1);
											setHighlight(0);
											refocus();
										}}
										className={cn(ROW, "text-ui", index === hi && "bg-muted")}
									>
										<Workflow
											className="size-3 shrink-0 text-muted-foreground"
											strokeWidth={1.8}
										/>
										<span className="shrink-0 truncate font-medium text-foreground">
											{part.name}
										</span>
										<span className={cn("text-mini", statusTone(part.status))}>
											{WORKFLOW_STATUS_LABEL[part.status]}
										</span>
										<span className="ml-auto shrink-0 truncate text-mini text-muted-foreground/60">
											{runMeta(part)}
										</span>
										<ChevronRight
											className="size-3.5 shrink-0 text-muted-foreground/40"
											strokeWidth={1.8}
										/>
									</button>
								))}
							</div>
						)
					) : level === 1 ? (
						<div className="flex flex-col gap-0.5">
							{flat.length === 0 ? (
								<p className="px-1 py-2 text-ui leading-6 text-muted-foreground">
									No agents reported yet.
								</p>
							) : (
								rows.map((row) =>
									row.kind === "phase" ? (
										<div
											key={`phase-${row.title}`}
											className="mt-1 px-2 pt-0.5 text-nano font-medium uppercase tracking-[0.06em] text-muted-foreground/60"
										>
											{row.title}
										</div>
									) : (
										<button
											key={`agent-${row.index}`}
											type="button"
											ref={row.index === hi ? activeRef : undefined}
											onMouseEnter={() => setHighlight(row.index)}
											onClick={() => {
												setAgentIndex(row.index);
												setLevel(2);
												refocus();
											}}
											className={cn(
												ROW,
												"text-ui",
												row.index === hi && "bg-muted",
											)}
										>
											{row.agent.status === "done" ? (
												<Check
													className="size-3 shrink-0 text-chart-2"
													strokeWidth={1.8}
												/>
											) : (
												<CircleDot
													className="size-3 shrink-0 text-muted-foreground/60"
													strokeWidth={1.8}
												/>
											)}
											<span className="shrink-0 truncate text-foreground">
												{row.agent.label}
											</span>
											{row.agent.resultPreview ? (
												<span className="truncate text-muted-foreground/60">
													— {row.agent.resultPreview}
												</span>
											) : null}
											<ChevronRight
												className="ml-auto size-3.5 shrink-0 text-muted-foreground/40"
												strokeWidth={1.8}
											/>
										</button>
									),
								)
							)}
							{run ? (
								<div className="mt-1.5 px-2 text-mini text-muted-foreground/60">
									{runMeta(run)}
								</div>
							) : null}
						</div>
					) : (
						(() => {
							const agent =
								flat[Math.min(agentIndex, Math.max(0, flat.length - 1))];
							if (!agent) {
								return (
									<p className="px-1 py-2 text-ui text-muted-foreground">
										Agent unavailable.
									</p>
								);
							}
							const done = agent.status === "done";
							const meta = agentMeta(agent);
							return (
								<div className="flex flex-col gap-1.5 px-1 py-0.5">
									<div className="flex items-center gap-1.5">
										{done ? (
											<Check
												className="size-3.5 shrink-0 text-chart-2"
												strokeWidth={1.8}
											/>
										) : (
											<CircleDot
												className="size-3.5 shrink-0 text-muted-foreground/60"
												strokeWidth={1.8}
											/>
										)}
										<span className="truncate font-medium text-foreground">
											{agent.label}
										</span>
										<span className="ml-auto shrink-0 text-mini text-muted-foreground/60">
											{done ? "done" : "running"}
										</span>
									</div>
									{meta ? (
										<div className="text-mini text-muted-foreground/60">
											{meta}
										</div>
									) : null}
									{agent.resultPreview ? (
										<Suspense
											fallback={
												<pre className="mt-0.5 whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-2 text-ui leading-6 text-foreground">
													{agent.resultPreview}
												</pre>
											}
										>
											<div className="mt-0.5 rounded-md bg-muted/50 px-2.5 py-2 text-foreground">
												<LazyStreamdown
													className="conversation-streamdown"
													mode="static"
												>
													{agent.resultPreview}
												</LazyStreamdown>
											</div>
										</Suspense>
									) : (
										<div className="text-ui text-muted-foreground/60">
											No result preview.
										</div>
									)}
								</div>
							);
						})()
					)}
				</div>
			</div>
		</div>
	);
}
