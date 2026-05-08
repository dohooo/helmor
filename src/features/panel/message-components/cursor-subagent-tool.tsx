/**
 * Renders Cursor's subagent invocation tool calls.
 *
 * Cursor's wire shape (after `cursor.rs::translate_cursor_tool` renames
 * `task` → `cursor_task`):
 *
 *   args: {
 *     agentId:      string,    // subagent runtime id (used for color identity)
 *     subagentType: string,    // role label, e.g. "code-reviewer"
 *     description:  string,    // one-line summary
 *     prompt:       string,    // full instructions sent to the subagent
 *     model:        string,    // e.g. "composer-2"
 *     mode:         string,    // collab mode, e.g. "auto"
 *   }
 *   result?: string | object   // subagent's final output, present on completion
 *
 * Visual model intentionally diverges from claude/codex because cursor
 * subagents have different lifecycle:
 *   - claude `Task` folds child tool calls under the parent (we'd render
 *     a step list). Cursor doesn't expose child events — there's nothing
 *     to fold.
 *   - codex `subagent_*` covers spawn/wait/send/resume/close — separate
 *     events. Cursor packages everything in one `task` tool call: args
 *     in, result out.
 *
 * So this renderer is single-row + expandable (prompt + result), styled
 * with the same tokens (`Bot` icon, `bg-accent/35` body, agent-color
 * accent) so it reads as part of the same visual family.
 */

import {
	AlertCircle,
	Bot,
	Check,
	ChevronDown,
	LoaderCircle,
} from "lucide-react";
import { memo, useState } from "react";
import type { ToolCallPart } from "@/lib/api";
import { getSubagentIdentity } from "@/lib/subagent-identity";
import { cn } from "@/lib/utils";

const CURSOR_SUBAGENT_TOOL_NAME = "cursor_task";

export function isCursorSubagentToolName(toolName: string): boolean {
	return toolName === CURSOR_SUBAGENT_TOOL_NAME;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isLiveStatus(status: string | null | undefined): boolean {
	return (
		status === "running" || status === "streaming_input" || status === "pending"
	);
}

function statusGlyph(streamingStatus: string | undefined, isError: boolean) {
	if (isLiveStatus(streamingStatus)) {
		return (
			<LoaderCircle
				className="size-3 shrink-0 animate-spin text-muted-foreground/50"
				strokeWidth={2}
			/>
		);
	}
	if (isError || streamingStatus === "error") {
		return (
			<AlertCircle
				className="size-3 shrink-0 text-destructive"
				strokeWidth={2}
			/>
		);
	}
	if (streamingStatus === "done") {
		return <Check className="size-3 shrink-0 text-chart-2" strokeWidth={2} />;
	}
	return null;
}

/// Cursor's tool result is `{status, value}` for shell, or for `task`
/// usually a free-form string in `value` (the subagent's final output).
/// Fallback to JSON.stringify for unexpected shapes.
function formatResult(result: unknown): string | null {
	if (result == null) return null;
	if (typeof result === "string") return result.trim() || null;
	if (typeof result === "object") {
		const obj = result as Record<string, unknown>;
		if (typeof obj.value === "string")
			return (obj.value as string).trim() || null;
		if (obj.value && typeof obj.value === "object") {
			return JSON.stringify(obj.value, null, 2);
		}
		return JSON.stringify(result, null, 2);
	}
	return String(result);
}

export const CursorSubagentToolCall = memo(function CursorSubagentToolCall({
	part,
}: {
	part: ToolCallPart;
}) {
	const args = part.args;
	const agentId = str(args.agentId);
	const subagentType = str(args.subagentType) ?? "Sub-agent";
	const description = str(args.description);
	const prompt = str(args.prompt);
	const model = str(args.model);
	const mode = str(args.mode);
	const resultText = formatResult(part.result);

	const identity = agentId ? getSubagentIdentity(agentId, subagentType) : null;
	const accent = identity ? { color: identity.color } : undefined;

	const expandable = !!prompt || !!resultText;
	const [open, setOpen] = useState(false);

	const live = isLiveStatus(part.streamingStatus);
	const glyph = statusGlyph(part.streamingStatus, part.isError === true);

	return (
		<div className="my-0.5 flex flex-col">
			<button
				type="button"
				onClick={() => expandable && setOpen((v) => !v)}
				disabled={!expandable}
				className={cn(
					"flex w-full flex-wrap items-center gap-x-1.5 gap-y-0 py-0.5 text-left text-[12px] text-muted-foreground",
					expandable ? "cursor-pointer" : "cursor-default",
				)}
			>
				<Bot
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
				<span className="font-medium" style={accent}>
					{subagentType}
				</span>
				{mode ? (
					<span className="text-muted-foreground/70">· {mode}</span>
				) : null}
				{description ? (
					<span className="min-w-0 truncate text-muted-foreground/60">
						{description}
					</span>
				) : null}
				{model ? (
					<span className="ml-auto shrink-0 text-[11px] text-muted-foreground/40">
						{model}
					</span>
				) : null}
				{glyph}
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
			{open && expandable ? (
				<div className="ml-5 mt-1 flex flex-col gap-2 border-l border-border/30 pl-3">
					{prompt ? (
						<div className="flex flex-col gap-1">
							<span className="text-[11px] uppercase tracking-wide text-muted-foreground/50">
								Prompt
							</span>
							<div className="whitespace-pre-wrap break-words rounded-md bg-accent/35 px-2.5 py-1.5 text-[12px] leading-5 text-muted-foreground/85">
								{prompt}
							</div>
						</div>
					) : null}
					<div className="flex flex-col gap-1">
						<span className="text-[11px] uppercase tracking-wide text-muted-foreground/50">
							Result
						</span>
						{resultText ? (
							<div className="whitespace-pre-wrap break-words rounded-md bg-accent/35 px-2.5 py-1.5 text-[12px] leading-5 text-muted-foreground/85">
								{resultText}
							</div>
						) : (
							<div className="flex items-center gap-1.5 rounded-md bg-accent/20 px-2.5 py-1.5 text-[12px] text-muted-foreground/60">
								{live ? (
									<>
										<LoaderCircle
											className="size-3 animate-spin text-muted-foreground/50"
											strokeWidth={2}
										/>
										<span>Waiting for subagent…</span>
									</>
								) : (
									<span>No output captured.</span>
								)}
							</div>
						)}
					</div>
				</div>
			) : null}
		</div>
	);
});
