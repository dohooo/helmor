import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	CircleStop,
	Download,
	KeyRound,
	MessageSquareQuote,
	MinusCircle,
	Play,
	Settings as SettingsIcon,
	Square,
	Wrench,
	XCircle,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";
import {
	GithubBrandIcon,
	GitlabBrandIcon,
	LarkBrandIcon,
	SlackBrandIcon,
} from "@/components/brand-icon";
import { LarkConnectDialog } from "@/components/lark-connect-dialog";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	cancelTriageTick,
	countOpenTriageCandidates,
	getLocalLlmStatus,
	getTriageActiveStatus,
	getTriageConfig,
	getTriageSourceHealth,
	type LarkAuthAction,
	type LastTickOutcome,
	type TriageActiveStatus,
	type TriageConfig,
	type TriageSourceHealth,
	type TriageSourceHealthState,
	triggerTriageTickNow,
	updateTriageConfig,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { publishShellEvent } from "@/shell/event-bus";
import { SettingsReleaseBadge } from "../components/release-marker";

const LOCAL_LLM_STATUS_KEY = ["localLlmStatus"] as const;
const PENDING_CANDIDATES_KEY = ["triagePendingCandidates"] as const;
const SOURCE_HEALTH_KEY = ["triageSourceHealth"] as const;

type BrandIcon = ComponentType<{ size?: number; className?: string }>;

const SOURCE_ICONS: Record<string, BrandIcon> = {
	lark: LarkBrandIcon,
	slack: SlackBrandIcon,
	github: GithubBrandIcon,
	gitlab: GitlabBrandIcon,
};

function formatElapsed(startedAt: string, now: number): string {
	const start = Date.parse(startedAt);
	if (Number.isNaN(start)) return "";
	const sec = Math.max(0, Math.floor((now - start) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	return `${min}m ${sec % 60}s`;
}

function formatTimeAgo(iso: string, now: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const sec = Math.max(0, Math.floor((now - t) / 1000));
	// Don't tick second-by-second under a minute.
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.floor(hr / 24)}d ago`;
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString();
}

// Shared 1Hz clock for elapsed / "X ago" labels.
function useTickingNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	return now;
}

export function TriagePanel() {
	const queryClient = useQueryClient();
	const now = useTickingNow();
	const llmStatus = useQuery({
		queryKey: LOCAL_LLM_STATUS_KEY,
		queryFn: getLocalLlmStatus,
		refetchInterval: 2000,
	});
	const config = useQuery({
		queryKey: helmorQueryKeys.triageConfig,
		queryFn: getTriageConfig,
	});
	const status = useQuery({
		queryKey: helmorQueryKeys.triageActiveStatus,
		queryFn: getTriageActiveStatus,
		refetchInterval: 1000,
	});
	const pendingCount = useQuery({
		queryKey: PENDING_CANDIDATES_KEY,
		queryFn: countOpenTriageCandidates,
		refetchInterval: 5000,
	});
	const sourceHealth = useQuery({
		queryKey: SOURCE_HEALTH_KEY,
		queryFn: getTriageSourceHealth,
		// Refresh slow enough not to hammer `lark-cli --version` every
		// second, fast enough that fixing a missing login feels live.
		refetchInterval: 15000,
	});

	const [draft, setDraft] = useState<TriageConfig | null>(null);

	useEffect(() => {
		if (config.data) setDraft(config.data);
	}, [config.data]);

	const save = useMutation({
		mutationFn: (next: TriageConfig) => updateTriageConfig(next),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.triageConfig,
			});
		},
	});

	const trigger = useMutation({
		mutationFn: () => triggerTriageTickNow(),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.triageActiveStatus,
			});
		},
	});

	const stop = useMutation({
		mutationFn: () => cancelTriageTick(),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.triageActiveStatus,
			});
		},
	});

	if (!draft) {
		return (
			<div className="flex flex-col gap-3 py-5">
				<HeaderBar disabled />
			</div>
		);
	}

	const isLlmRunning = !!llmStatus.data?.running;
	const active = status.data?.active ?? null;
	const lastOutcome = status.data?.lastOutcome ?? null;
	const isRunning = active != null;
	const canEnable = isLlmRunning;
	const triageOn = draft.enabled && canEnable;

	const commit = (patch: Partial<TriageConfig>) => {
		const next: TriageConfig = { ...draft, ...patch };
		setDraft(next);
		save.mutate(next);
	};

	return (
		<div className="flex flex-col gap-3 py-5">
			<HeaderBar
				enabled={draft.enabled}
				disabled={!canEnable}
				onChange={(v) => commit({ enabled: v })}
			/>

			{triageOn ? (
				<div className="flex w-full flex-col gap-3">
					<Field
						label="Custom instructions"
						hint="Tell the triage agent what to focus on, in plain language."
					>
						<Textarea
							value={draft.systemPrompt}
							onChange={(e) =>
								setDraft({ ...draft, systemPrompt: e.target.value })
							}
							onBlur={() => save.mutate(draft)}
							placeholder={`e.g.
• Watch Slack #incidents and DMs from my team lead
• Surface every Slack message that @-mentions me
• Skip bot notifications and weekly digests`}
							className="min-h-[96px] placeholder:text-ui"
						/>
					</Field>

					<Field
						label="Sources"
						hint="Where Helmor pulls triage candidates from. Incremental fetch every 5 minutes."
					>
						<div className="flex flex-col divide-y divide-border/40 rounded-md border border-border/60 bg-background/30">
							{sourceHealth.data?.map((row) => (
								<SourceRow key={row.source} row={row} />
							)) ?? (
								<div className="px-3 py-2.5 text-mini text-muted-foreground">
									Checking source health…
								</div>
							)}
						</div>
					</Field>

					<div className="text-mini text-muted-foreground">
						{pendingCount.isLoading ? (
							"Loading candidate queue…"
						) : (
							<span>
								<span className="font-medium text-foreground">
									{pendingCount.data ?? 0}
								</span>{" "}
								candidate{pendingCount.data === 1 ? "" : "s"} waiting to be
								judged.
							</span>
						)}
					</div>

					<div className="flex items-center justify-between gap-3">
						<OutcomeLine last={lastOutcome} now={now} />
						<div className="flex shrink-0 items-center gap-3">
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<div className="flex items-center gap-1.5 text-mini text-muted-foreground">
											<span>Auto-run</span>
											<Switch
												checked={draft.autoRun}
												onCheckedChange={(v) => commit({ autoRun: v })}
												aria-label="Auto-run heartbeat"
											/>
										</div>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										className="max-w-[260px] flex-col items-start space-y-1.5 text-[11px] leading-5"
									>
										<p>
											<span className="font-semibold">On</span> — a tick fires
											right after each fetch (every 5 minutes). Overlapping
											ticks are skipped.
										</p>
										<p>
											<span className="font-semibold">Off</span> — ticks only
											run when you press Run now.
										</p>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							{isRunning ? (
								<Button
									variant="destructive"
									size="sm"
									disabled={stop.isPending}
									onClick={() => stop.mutate()}
								>
									<Square className="size-3.5 fill-current" />
									{stop.isPending ? "Stopping…" : "Stop"}
								</Button>
							) : (
								<Button
									variant="outline"
									size="sm"
									disabled={trigger.isPending}
									onClick={() => trigger.mutate()}
								>
									<Play className="size-3.5" />
									Run now
								</Button>
							)}
						</div>
					</div>

					{isRunning && active ? (
						<ActiveStatusCard status={active} now={now} />
					) : null}
				</div>
			) : null}
		</div>
	);
}

function HeaderBar({
	enabled = false,
	disabled = false,
	onChange,
}: {
	enabled?: boolean;
	disabled?: boolean;
	onChange?: (v: boolean) => void;
}) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium leading-snug text-foreground">
					<span className="min-w-0">Smart triage</span>
					<SettingsReleaseBadge marker={{ kind: "feature" }} />
				</div>
				<p className="mt-1 text-[12px] leading-snug text-muted-foreground">
					The local LLM scans your enabled sources and creates AI-prepared
					workspaces for actionable items.
				</p>
			</div>
			<Switch
				checked={enabled}
				disabled={disabled}
				onCheckedChange={(v) => onChange?.(v)}
			/>
		</div>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="text-ui font-medium">{label}</div>
			{hint ? (
				<div className="text-mini text-muted-foreground">{hint}</div>
			) : null}
			<div>{children}</div>
		</div>
	);
}

// HoverCard (not Tooltip) so users can scroll long markdown summaries.
function SummaryPopover({ text }: { text: string }) {
	return (
		<HoverCard openDelay={120} closeDelay={120}>
			<HoverCardTrigger asChild>
				<button
					type="button"
					aria-label="Show agent reasoning"
					className="inline-flex shrink-0 cursor-pointer text-muted-foreground/60 hover:text-foreground"
				>
					<MessageSquareQuote className="size-3" />
				</button>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="end"
				className="w-[480px] max-w-[calc(100vw-4rem)] p-0"
			>
				<div className="max-h-[360px] overflow-y-auto px-3 py-2.5">
					<div className="conversation-markdown max-w-none break-words text-foreground">
						<LazyStreamdown
							animated={false}
							caret={undefined}
							className="conversation-streamdown"
							isAnimating={false}
						>
							{text}
						</LazyStreamdown>
					</div>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

function OutcomeLine({
	last,
	now,
}: {
	last: LastTickOutcome | null;
	now: number;
}) {
	if (!last) {
		return (
			<div className="min-w-0 flex-1 truncate text-mini text-muted-foreground">
				No tick run yet.
			</div>
		);
	}
	const when = formatTimeAgo(last.at, now);
	const o = last.outcome;
	const summary = last.summary;
	if (o.kind === "createdWorkspaces") {
		return (
			<div className="flex min-w-0 flex-1 items-center gap-1.5 text-mini text-foreground">
				<CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
				<span className="truncate">
					Last tick · {when} · created {o.count} workspace
					{o.count === 1 ? "" : "s"}
				</span>
				{summary ? <SummaryPopover text={summary} /> : null}
			</div>
		);
	}
	if (o.kind === "noActionableItems") {
		return (
			<div className="flex min-w-0 flex-1 items-center gap-1.5 text-mini text-muted-foreground">
				<MinusCircle className="size-3.5 shrink-0" />
				<span className="truncate">
					Last tick · {when} · nothing actionable
				</span>
				{summary ? <SummaryPopover text={summary} /> : null}
			</div>
		);
	}
	if (o.kind === "cancelled") {
		// Stop pressed by the user — neutral grey, not the red `failed` look.
		return (
			<div className="flex min-w-0 flex-1 items-center gap-1.5 text-mini text-muted-foreground">
				<CircleStop className="size-3.5 shrink-0" />
				<span className="truncate">Last tick · {when} · stopped</span>
				{summary ? <SummaryPopover text={summary} /> : null}
			</div>
		);
	}
	// failed — error message goes through the same tooltip surface.
	return (
		<div className="flex min-w-0 flex-1 items-center gap-1.5 text-mini text-destructive">
			<XCircle className="size-3.5 shrink-0" />
			<span className="truncate">Last tick · {when} · failed</span>
			<SummaryPopover text={summary || o.message || "(no message)"} />
		</div>
	);
}

function ActiveStatusCard({
	status,
	now,
}: {
	status: TriageActiveStatus;
	now: number;
}) {
	const [expanded, setExpanded] = useState(false);

	const calls = useMemo(
		() => [...status.recentToolCalls].reverse(),
		[status.recentToolCalls],
	);

	const batchLabel =
		status.batchIndex > 0 && status.batchTotal > 0
			? `Batch ${status.batchIndex} of ${status.batchTotal}`
			: null;
	return (
		<div className="rounded-lg border border-border/60 bg-card/40 p-3">
			<div className="flex items-center gap-2">
				<span className="inline-block size-2 animate-pulse rounded-full bg-chart-2" />
				<span className="text-ui font-medium">Tick running</span>
				{batchLabel ? (
					<span className="rounded-md bg-accent/40 px-1.5 py-0.5 text-mini font-medium text-foreground">
						{batchLabel}
					</span>
				) : null}
				<span className="text-mini text-muted-foreground">
					{formatElapsed(status.startedAt, now)} · turn {status.turnCount} ·{" "}
					{status.toolCount} tool calls
				</span>
			</div>
			<div className="mt-1 text-mini text-muted-foreground">
				Started {formatTime(status.startedAt)}
				{status.lastToolName ? ` · last: ${status.lastToolName}` : ""}
			</div>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="mt-2 flex items-center gap-1 text-mini text-muted-foreground hover:text-foreground"
			>
				{expanded ? (
					<ChevronDown className="size-3.5" />
				) : (
					<ChevronRight className="size-3.5" />
				)}
				{expanded ? "Hide" : "Show"} tool call list
			</button>
			{expanded ? (
				<ol className="mt-2 max-h-[280px] space-y-0.5 overflow-y-auto rounded border border-border/40 bg-background/40 p-2">
					{calls.length === 0 ? (
						<li className="text-mini text-muted-foreground">
							No tool calls yet.
						</li>
					) : (
						calls.map((c, idx) => (
							<li
								key={`${c.at}-${idx}`}
								className={cn(
									"flex items-start gap-2 rounded px-1.5 py-1 text-mini",
									idx === 0 && "bg-accent/30",
								)}
							>
								<Wrench className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
								<span className="w-14 shrink-0 font-mono text-muted-foreground">
									{formatTime(c.at)}
								</span>
								<span className="w-36 shrink-0 font-medium">{c.tool}</span>
								<span className="flex-1 truncate font-mono text-muted-foreground">
									{c.argsPreview}
								</span>
							</li>
						))
					)}
				</ol>
			) : null}
		</div>
	);
}

function stateBadge(state: TriageSourceHealthState): {
	label: string;
	tone: string;
	Icon: ComponentType<{ className?: string }>;
} {
	switch (state) {
		case "ok":
			return {
				label: "Connected",
				tone: "text-emerald-600 dark:text-emerald-400",
				Icon: CheckCircle2,
			};
		case "notInstalled":
			return {
				label: "Install required",
				tone: "text-amber-600 dark:text-amber-400",
				Icon: Download,
			};
		case "notAuthed":
			return {
				label: "Sign-in required",
				tone: "text-amber-600 dark:text-amber-400",
				Icon: KeyRound,
			};
		case "notConfigured":
			return {
				label: "Not configured",
				tone: "text-muted-foreground",
				Icon: SettingsIcon,
			};
		case "degraded":
			return {
				label: "Attention",
				tone: "text-amber-600 dark:text-amber-400",
				Icon: AlertTriangle,
			};
		default:
			return {
				label: "Unknown",
				tone: "text-muted-foreground",
				Icon: AlertTriangle,
			};
	}
}

function SourceRow({ row }: { row: TriageSourceHealth }) {
	const Icon = SOURCE_ICONS[row.source] ?? AlertTriangle;
	const { label, tone, Icon: StateIcon } = stateBadge(row.state);
	// Lark = in-app terminal; Slack = jump to Contexts panel; gh/glab need no CTA.
	const larkAction = larkConnectAction(row);
	const slackNeedsConnect = slackConnectNeeded(row);
	const [dialogOpen, setDialogOpen] = useState(false);
	// Button replaces the badge when present.
	const showBadge = !larkAction && !slackNeedsConnect;
	return (
		<>
			<div className="flex items-center gap-3 px-3 py-2.5">
				<Icon size={16} className="shrink-0 text-foreground" />
				<span className="shrink-0 text-ui font-medium">{row.displayName}</span>
				<span className="min-w-0 flex-1 truncate text-mini text-muted-foreground">
					{row.detail}
				</span>
				{larkAction ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setDialogOpen(true)}
					>
						Connect
					</Button>
				) : null}
				{slackNeedsConnect ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() =>
							publishShellEvent({
								type: "open-settings",
								section: "inbox",
								inboxProvider: "slack",
							})
						}
					>
						Connect
					</Button>
				) : null}
				{showBadge ? (
					<span
						className={cn(
							"inline-flex shrink-0 items-center gap-1 text-mini",
							tone,
						)}
					>
						<StateIcon className="size-3" />
						{label}
					</span>
				) : null}
			</div>
			{larkAction ? (
				<LarkConnectDialog
					open={dialogOpen}
					onOpenChange={setDialogOpen}
					action={larkAction}
				/>
			) : null}
		</>
	);
}

function larkConnectAction(row: TriageSourceHealth): LarkAuthAction | null {
	if (row.source !== "lark") return null;
	if (row.state === "notInstalled") return "install";
	if (row.state === "notAuthed") return "signIn";
	return null;
}

function slackConnectNeeded(row: TriageSourceHealth): boolean {
	return row.source === "slack" && row.state === "notAuthed";
}
