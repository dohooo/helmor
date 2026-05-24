import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Info,
	MinusCircle,
	Play,
	Wrench,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	getLocalLlmStatus,
	getTriageActiveStatus,
	getTriageConfig,
	type LastTickOutcome,
	type TriageActiveStatus,
	type TriageConfig,
	triggerTriageTickNow,
	updateTriageConfig,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { SettingsReleaseBadge } from "../components/release-marker";

// Keep in sync with sidecar/src/triage/providers/registry.ts.
const PROVIDER_SPECS: ReadonlyArray<{
	id: string;
	displayName: string;
	description: string;
}> = [
	{
		id: "slack",
		displayName: "Slack",
		description: "Scans Slack inbox / search across connected workspaces.",
	},
	{
		id: "lark",
		displayName: "Lark / Feishu",
		description:
			"Scans messages via lark-cli. Sign in once with `lark-cli auth login`.",
	},
	{
		id: "gitlab",
		displayName: "GitLab",
		description:
			"Scans GitLab inbox (issues/MRs). Sign in with `glab auth login`.",
	},
	{
		id: "github",
		displayName: "GitHub",
		description:
			"Scans GitHub inbox (issues/PRs). Sign in with `gh auth login`.",
	},
];

const LOCAL_LLM_STATUS_KEY = ["localLlmStatus"] as const;

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
	// Sub-minute: don't tick second-by-second — a jumping number reads
	// like "something is happening" when nothing is.
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

/// Single 1Hz heartbeat shared by elapsed / "X ago" labels. Keeps every
/// time-derived string in sync without each consumer wiring its own
/// setInterval (which previously froze at "0s" when React Query refetch
/// timing collided with the local tick).
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

	const setProviderEnabled = (id: string, enabled: boolean) => {
		commit({ providers: { ...draft.providers, [id]: enabled } });
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
						hint="Toggle each integration; CLI auth must already be set up."
					>
						<div className="flex flex-col divide-y divide-border/40 rounded-md border border-border/60 bg-background/30">
							{PROVIDER_SPECS.map((spec) => (
								<div
									key={spec.id}
									className="flex items-center justify-between gap-3 px-3 py-2.5"
								>
									<div className="min-w-0">
										<div className="text-ui font-medium">
											{spec.displayName}
										</div>
										<div className="text-mini text-muted-foreground">
											{spec.description}
										</div>
									</div>
									<Switch
										checked={draft.providers[spec.id] ?? false}
										onCheckedChange={(c) => setProviderEnabled(spec.id, c)}
									/>
								</div>
							))}
						</div>
					</Field>

					<div className="flex items-center justify-between gap-3">
						<OutcomeLine last={lastOutcome} now={now} />
						<Button
							variant="outline"
							size="sm"
							disabled={isRunning || trigger.isPending}
							onClick={() => trigger.mutate()}
						>
							<Play className="size-3.5" />
							{isRunning ? "Running…" : "Run a tick"}
						</Button>
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
					<span className="min-w-0">Auto-triage</span>
					<SettingsReleaseBadge marker={{ kind: "feature" }} />
				</div>
				<p className="mt-1 text-[12px] leading-snug text-muted-foreground">
					On a heartbeat, the local LLM scans enabled sources and creates
					AI-prepared workspaces for actionable items.
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
	if (o.kind === "createdWorkspaces") {
		return (
			<div className="flex min-w-0 flex-1 items-center gap-1.5 text-mini text-foreground">
				<CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
				<span className="truncate">
					Last tick · {when} · created {o.count} workspace
					{o.count === 1 ? "" : "s"}
				</span>
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
				{o.reason ? (
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label="Why nothing was proposed"
									className="inline-flex shrink-0 cursor-help text-muted-foreground/60 hover:text-foreground"
								>
									<Info className="size-3" />
								</button>
							</TooltipTrigger>
							<TooltipContent
								side="top"
								className="max-w-[420px] whitespace-pre-wrap text-[11px] leading-5"
							>
								{o.reason}
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</div>
		);
	}
	// failed
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<div className="flex min-w-0 flex-1 cursor-help items-center gap-1.5 text-mini text-destructive">
						<XCircle className="size-3.5 shrink-0" />
						<span className="truncate">Last tick · {when} · failed</span>
					</div>
				</TooltipTrigger>
				<TooltipContent
					side="top"
					className="max-w-[360px] text-[11px] leading-5"
				>
					{o.message || "(no message)"}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
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

	return (
		<div className="rounded-lg border border-border/60 bg-card/40 p-3">
			<div className="flex items-center gap-2">
				<span className="inline-block size-2 animate-pulse rounded-full bg-chart-2" />
				<span className="text-ui font-medium">Tick running</span>
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
