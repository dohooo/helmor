/**
 * Renders Codex `collabAgentToolCall` items (sub-agent spawn / wait /
 * send_input / resume / close).
 *
 * Visual style: inline text + indented body with a left rule, matching
 *   1. Codex's own client (header "Spawned N agents" + indented "Created
 *      <Nickname> (<role>) with the instructions: <prompt>" rows), and
 *   2. Helmor's existing `AgentChildrenBlock` for Claude's Task tool —
 *      so all Codex/Claude sub-agent surfaces share one rhythm. No card
 *      wrappers, no muted backgrounds.
 *
 * The accumulator + adapter emit these as ToolCallParts with toolName
 * `subagent_spawn` / `subagent_wait` / `subagent_send_input` /
 * `subagent_resume` / `subagent_close`, with the original Codex item
 * fields preserved on `args`.
 */

import {
	AlertCircle,
	Bot,
	Check,
	ChevronDown,
	LoaderCircle,
	Sparkles,
} from "lucide-react";
import { memo, useState } from "react";
import type { ToolCallPart } from "@/lib/api";
import {
	getSubagentIdentity,
	type SubagentIdentity,
} from "@/lib/subagent-identity";
import { cn } from "@/lib/utils";

const SUBAGENT_TOOL_PREFIX = "subagent_";

export function isSubagentToolName(toolName: string): boolean {
	return toolName.startsWith(SUBAGENT_TOOL_PREFIX);
}

/** True iff `tool` is a spawn variant — used by the parts grouper to
 *  collect consecutive spawns into one "Spawned N agents" block. */
export function isSubagentSpawnPart(part: ToolCallPart): boolean {
	return part.toolName === "subagent_spawn";
}

interface AgentState {
	threadId: string;
	nickname: string | null;
	role: string | null;
	status: string | null;
	message: string | null;
}

function readAgentsStates(args: Record<string, unknown>): AgentState[] {
	const raw = args.agentsStates;
	if (!raw || typeof raw !== "object") return [];
	const out: AgentState[] = [];
	for (const [threadId, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== "object") continue;
		const o = v as Record<string, unknown>;
		out.push({
			threadId,
			nickname: typeof o.agentNickname === "string" ? o.agentNickname : null,
			role: typeof o.agentRole === "string" ? o.agentRole : null,
			status: typeof o.status === "string" ? o.status : null,
			message: typeof o.message === "string" ? o.message : null,
		});
	}
	return out;
}

function identityFor(state: AgentState): SubagentIdentity {
	return getSubagentIdentity(state.threadId, state.nickname);
}

function isLiveStatus(status: string | undefined | null): boolean {
	return status === "in_progress" || status === "inProgress";
}

// ----------------------------------------------------------------------------
// Spawn rendering — single row + grouped header
// ----------------------------------------------------------------------------

/** Visual depth for sub-agent rows.
 *  - `outer`: top-level row (single spawn, standalone misc/wait). Uses the
 *    same icon/text intensity as the group header so a row standing alone
 *    reads as "primary content".
 *  - `nested`: row inside a "Spawned N agents" / wait body. One step lighter
 *    so the group header keeps visual lead. */
type RowDepth = "outer" | "nested";

const DEPTH_TOKENS: Record<
	RowDepth,
	{ icon: string; muted: string; secondary: string }
> = {
	outer: {
		icon: "text-muted-foreground",
		muted: "text-muted-foreground",
		secondary: "text-muted-foreground/70",
	},
	nested: {
		icon: "text-muted-foreground/60",
		muted: "text-muted-foreground/80",
		secondary: "text-muted-foreground/60",
	},
};

function SpawnAgentRow({
	part,
	depth = "nested",
}: {
	part: ToolCallPart;
	depth?: RowDepth;
}) {
	const states = readAgentsStates(part.args);
	const prompt = typeof part.args.prompt === "string" ? part.args.prompt : null;
	// One spawn call typically targets exactly one new sub-agent; render the
	// first state if any. When `agentsStates` is empty (metadata fetch still
	// in flight, or item still in_progress), there's no threadId to derive
	// identity from — fall back to a neutral "Sub-agent" placeholder.
	const target = states[0];
	const identity = target ? identityFor(target) : null;
	const label = identity?.nickname ?? "Sub-agent";
	const role = target?.role;
	const [open, setOpen] = useState(false);
	const expandable = !!prompt && prompt.length > 0;

	const accent = identity ? { color: identity.color } : undefined;
	const tokens = DEPTH_TOKENS[depth];

	return (
		<div className="flex flex-col gap-0.5 text-[12px]">
			<button
				type="button"
				onClick={() => expandable && setOpen((v) => !v)}
				disabled={!expandable}
				className={cn(
					"flex w-full flex-wrap items-center gap-x-1.5 gap-y-0 text-left",
					tokens.muted,
					expandable ? "cursor-pointer" : "cursor-default",
				)}
			>
				<Bot
					className={cn("size-3.5 shrink-0", tokens.icon)}
					strokeWidth={1.8}
				/>
				<span>Created</span>
				<span className="font-medium" style={accent}>
					{label}
				</span>
				{role ? <span className={tokens.secondary}>({role})</span> : null}
				<span className={tokens.secondary}>with the instructions:</span>
				{expandable ? (
					<ChevronDown
						className={cn(
							"size-3 shrink-0 text-muted-foreground/40 transition-transform",
							open ? "" : "-rotate-90",
						)}
						strokeWidth={1.8}
					/>
				) : null}
			</button>
			{prompt ? (
				open ? (
					<div className="ml-5 mt-0.5 whitespace-pre-wrap break-words rounded-md bg-accent/35 px-2.5 py-1.5 text-[12px] leading-5 text-muted-foreground/85">
						{prompt}
					</div>
				) : (
					<div className="ml-5 line-clamp-2 break-words text-muted-foreground/60">
						{prompt}
					</div>
				)
			) : null}
		</div>
	);
}

/** "Spawned N agents" header + indented body. Defaults open while any
 *  spawn is in flight or count===1; closed otherwise. */
export function SubAgentSpawnGroup({ parts }: { parts: ToolCallPart[] }) {
	const live = parts.some(
		(p) =>
			typeof p.args.status === "string" &&
			isLiveStatus(p.args.status as string),
	);
	const [open, setOpen] = useState(live || parts.length === 1);
	const count = parts.length;

	if (count === 0) return null;

	// Single spawn: show as a bare row without the "Spawned 1 agents" header.
	// Uses outer depth so the bot icon and "Created" text match the visual
	// intensity that `Spawned N agents` would have.
	if (count === 1) {
		return (
			<div className="my-0.5">
				<SpawnAgentRow part={parts[0]!} depth="outer" />
			</div>
		);
	}

	return (
		<div className="my-0.5 flex flex-col">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-fit cursor-pointer items-center gap-1.5 py-0.5 text-left text-[12px] text-muted-foreground"
			>
				<Sparkles
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
				<span className="font-medium">Spawned {count} agents</span>
				<ChevronDown
					className={cn(
						"size-3 shrink-0 text-muted-foreground/40 transition-transform",
						open ? "" : "-rotate-90",
					)}
					strokeWidth={1.8}
				/>
			</button>
			{open ? (
				<div className="ml-[7px] mt-1 flex flex-col gap-2 border-l border-border/30 pl-3">
					{parts.map((p) => (
						<SpawnAgentRow key={p.toolCallId} part={p} depth="nested" />
					))}
				</div>
			) : null}
		</div>
	);
}

// ----------------------------------------------------------------------------
// Wait / send / resume / close — single row each, same plain-text rhythm
// ----------------------------------------------------------------------------

function statusGlyph(status: string, isError: boolean) {
	if (isLiveStatus(status)) {
		// Match CollapsedToolGroup's spinner so all "active group" surfaces
		// share one loading affordance.
		return (
			<LoaderCircle
				className="size-3 shrink-0 animate-spin text-muted-foreground/50"
				strokeWidth={2}
			/>
		);
	}
	if (status === "failed" || isError) {
		return <AlertCircle className="size-3 text-destructive" strokeWidth={2} />;
	}
	if (status === "completed") {
		return <Check className="size-3 text-chart-2" strokeWidth={2} />;
	}
	return null;
}

function SubAgentWaitRow({ part }: { part: ToolCallPart }) {
	const states = readAgentsStates(part.args);
	const status =
		typeof part.args.status === "string" ? part.args.status : "completed";
	const isError = part.isError === true;
	const [open, setOpen] = useState(false);

	const completedCount = states.filter((s) => s.status === "completed").length;
	const totalCount = states.length;
	const headline = isLiveStatus(status)
		? `Waiting on ${totalCount || "agents"}…`
		: completedCount > 0
			? `Collected ${completedCount} of ${totalCount} agent results`
			: "Waiting complete";

	const hasBodies = states.some(
		(s) => typeof s.message === "string" && s.message.trim().length > 0,
	);

	return (
		<div className="my-0.5 flex flex-col">
			<button
				type="button"
				onClick={() => hasBodies && setOpen((v) => !v)}
				disabled={!hasBodies}
				className={cn(
					"flex w-fit items-center gap-1.5 py-0.5 text-left text-[12px] text-muted-foreground",
					hasBodies ? "cursor-pointer" : "cursor-default",
				)}
			>
				<Sparkles
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
				<span className="font-medium">{headline}</span>
				{statusGlyph(status, isError)}
				{hasBodies ? (
					<ChevronDown
						className={cn(
							"size-3 shrink-0 text-muted-foreground/40 transition-transform",
							open ? "" : "-rotate-90",
						)}
						strokeWidth={1.8}
					/>
				) : null}
			</button>
			{open && hasBodies ? (
				<div className="ml-[7px] mt-1 flex flex-col gap-2 border-l border-border/30 pl-3 text-[12px]">
					{states.map((s) => {
						const id = identityFor(s);
						const accent = { color: id.color };
						const tokens = DEPTH_TOKENS.nested;
						return (
							<div key={s.threadId} className="flex flex-col gap-0.5">
								<div
									className={cn(
										"flex flex-wrap items-center gap-x-1.5 gap-y-0",
										tokens.muted,
									)}
								>
									<Bot
										className={cn("size-3.5 shrink-0", tokens.icon)}
										strokeWidth={1.8}
									/>
									<span className="font-medium" style={accent}>
										{id.nickname}
									</span>
									{s.role ? (
										<span className={tokens.secondary}>({s.role})</span>
									) : null}
									<span className={tokens.secondary}>— {s.status}</span>
								</div>
								{s.message ? (
									<div className="ml-5 whitespace-pre-wrap break-words rounded-md bg-accent/35 px-2.5 py-1.5 text-[12px] leading-5 text-muted-foreground/85">
										{s.message}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

function SubAgentMiscRow({ part }: { part: ToolCallPart }) {
	// send_input / resume / close — minimal one-liner.
	const verb =
		part.toolName === "subagent_send_input"
			? "Sent input"
			: part.toolName === "subagent_resume"
				? "Resumed"
				: part.toolName === "subagent_close"
					? "Closed"
					: "Sub-agent action";
	const states = readAgentsStates(part.args);
	const target = states[0];
	const identity = target ? identityFor(target) : null;
	const role = target?.role;
	const status =
		typeof part.args.status === "string" ? part.args.status : "completed";
	const accent = identity ? { color: identity.color } : undefined;

	const tokens = DEPTH_TOKENS.outer;

	return (
		<div
			className={cn(
				"my-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0 text-[12px]",
				tokens.muted,
			)}
		>
			<Bot className={cn("size-3.5 shrink-0", tokens.icon)} strokeWidth={1.8} />
			<span className="font-medium">{verb}</span>
			{identity ? (
				<span className="font-medium" style={accent}>
					{identity.nickname}
				</span>
			) : null}
			{role ? <span className={tokens.secondary}>({role})</span> : null}
			{statusGlyph(status, part.isError === true)}
		</div>
	);
}

// ----------------------------------------------------------------------------
// Public dispatch
// ----------------------------------------------------------------------------

export const SubAgentToolCall = memo(function SubAgentToolCall({
	part,
}: {
	part: ToolCallPart;
}) {
	switch (part.toolName) {
		case "subagent_spawn":
			// Fallback. The main render path folds spawns into
			// `SubAgentSpawnGroup` upstream in `assistant-message.tsx`, so
			// this case only fires if a caller bypasses the grouper.
			return <SubAgentSpawnGroup parts={[part]} />;
		case "subagent_wait":
			return <SubAgentWaitRow part={part} />;
		case "subagent_send_input":
		case "subagent_resume":
		case "subagent_close":
			return <SubAgentMiscRow part={part} />;
		default:
			return null;
	}
});
