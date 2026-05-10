import { AlertCircle, AlertTriangle, Clock3, Info } from "lucide-react";
import { memo, Suspense } from "react";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai/reasoning";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { useSmoothStreamContent } from "@/features/conversation/hooks/use-smooth-stream-content";
import {
	type ExtendedMessagePart,
	partKey,
	type ToolCallPart,
} from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ImageBlock, PlanReviewCard, TodoList } from "./content-parts";
import {
	CursorSubagentToolCall,
	isCursorSubagentToolName,
} from "./cursor-subagent-tool";
import type { RenderedMessage, StreamdownMode } from "./shared";
import {
	isCollapsedGroupPart,
	isImagePart,
	isPlanReviewPart,
	isReasoningPart,
	isTextPart,
	isTodoListPart,
	isToolCallPart,
	reasoningLifecycle,
} from "./shared";
import {
	isSubagentSpawnPart,
	isSubagentToolName,
	SubAgentSpawnGroup,
	SubAgentToolCall,
} from "./subagent-tool";
import { AssistantToolCall, CollapsedToolGroup } from "./tool-call";

// --- AssistantText ---

// `animation` / `duration` / `easing` are pinned by the
// `[data-sd-animate]` rule in App.css; only `sep` + `stagger` matter here.
const STREAMING_ANIMATED = {
	sep: "char" as const,
	stagger: 0,
};

const AssistantText = memo(function AssistantText({
	text,
	streaming,
}: {
	text: string;
	streaming: boolean;
}) {
	const mode: StreamdownMode = streaming ? "streaming" : "static";
	const { settings } = useSettings();
	const smoothedText = useSmoothStreamContent(text, { enabled: streaming });

	return (
		<div
			className="conversation-markdown assistant-markdown-scale max-w-none break-words text-foreground"
			style={{ fontSize: `${settings.fontSize}px` }}
		>
			<Suspense fallback={<AssistantTextFallback text={smoothedText} />}>
				<LazyStreamdown
					animated={streaming ? STREAMING_ANIMATED : false}
					caret={undefined}
					className="conversation-streamdown"
					isAnimating={streaming}
					mode={mode}
				>
					{smoothedText}
				</LazyStreamdown>
			</Suspense>
		</div>
	);
});

function AssistantTextFallback({ text }: { text: string }) {
	return (
		<div className="conversation-streamdown whitespace-pre-wrap break-words">
			{text}
		</div>
	);
}

// --- MessageStatusBadge ---

function statusBadgeMeta(
	reason: string,
): { label: string; tone: string; icon: React.ReactNode } | null {
	const negativeTone = "bg-destructive/10 text-destructive";
	const warmTone = "bg-chart-5/10 text-chart-5";
	switch (reason) {
		case "max_tokens":
			return {
				label: "Output truncated",
				tone: warmTone,
				icon: <AlertTriangle className="size-3" strokeWidth={1.8} />,
			};
		case "context_window_exceeded":
			return {
				label: "Context window exceeded",
				tone: negativeTone,
				icon: <AlertCircle className="size-3" strokeWidth={1.8} />,
			};
		case "refusal":
			return {
				label: "Model declined",
				tone: warmTone,
				icon: <Info className="size-3" strokeWidth={1.8} />,
			};
		case "pause_turn":
			return {
				label: "Paused",
				tone: warmTone,
				icon: <Clock3 className="size-3" strokeWidth={1.8} />,
			};
		default:
			return {
				label: reason,
				tone: negativeTone,
				icon: <AlertCircle className="size-3" strokeWidth={1.8} />,
			};
	}
}

function MessageStatusBadge({ reason }: { reason?: string }) {
	if (!reason) {
		return null;
	}
	const meta = statusBadgeMeta(reason);
	if (!meta) {
		return null;
	}
	return (
		<div
			className={cn(
				"mt-1 inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
				meta.tone,
			)}
		>
			{meta.icon}
			<span>{meta.label}</span>
		</div>
	);
}

// Fold consecutive `subagent_spawn` ToolCallParts into a nested array; the
// render loop then dispatches arrays to SubAgentSpawnGroup.
function groupConsecutiveSubagentSpawns(
	parts: ExtendedMessagePart[],
): Array<ExtendedMessagePart | ToolCallPart[]> {
	const out: Array<ExtendedMessagePart | ToolCallPart[]> = [];
	let pending: ToolCallPart[] | null = null;

	const flush = () => {
		if (pending && pending.length > 0) {
			out.push(pending);
		}
		pending = null;
	};

	for (const part of parts) {
		if (
			part.type === "tool-call" &&
			isSubagentSpawnPart(part as ToolCallPart)
		) {
			if (!pending) pending = [];
			pending.push(part as ToolCallPart);
			continue;
		}
		flush();
		out.push(part);
	}
	flush();
	return out;
}

// --- ChatAssistantMessage ---

export function ChatAssistantMessage({
	message,
	streaming,
}: {
	message: RenderedMessage;
	streaming: boolean;
}) {
	const parts = message.content as ExtendedMessagePart[];
	const { settings } = useSettings();

	// Group consecutive `subagent_spawn` ToolCallParts so two parallel spawn
	// calls render as one "Spawned 2 agents" block (matches Codex's own
	// client). All other parts pass through unchanged. Done at render time
	// rather than in the Rust collapse stage so we don't need to introduce a
	// new MessagePart variant just for this UI affordance.
	const groupedParts = groupConsecutiveSubagentSpawns(parts);

	return (
		<div
			data-message-id={message.id}
			data-message-role="assistant"
			className="flex min-w-0 max-w-full flex-col gap-1"
		>
			{groupedParts.map((part) => {
				if (Array.isArray(part)) {
					// Spawn group: pass the whole array to one collapsible block.
					const groupKey = `spawn-group:${part[0]!.toolCallId}`;
					return (
						<SubAgentSpawnGroup key={groupKey} parts={part as ToolCallPart[]} />
					);
				}
				const key = partKey(part);
				if (isTextPart(part)) {
					return (
						<AssistantText key={key} text={part.text} streaming={streaming} />
					);
				}
				if (isReasoningPart(part)) {
					const durationSeconds =
						typeof part.durationMs === "number"
							? Math.max(1, Math.ceil(part.durationMs / 1000))
							: undefined;
					return (
						<Reasoning
							key={key}
							lifecycle={reasoningLifecycle(part)}
							duration={durationSeconds}
						>
							<ReasoningTrigger />
							<ReasoningContent fontSize={settings.fontSize}>
								{part.text}
							</ReasoningContent>
						</Reasoning>
					);
				}
				if (isCollapsedGroupPart(part)) {
					return <CollapsedToolGroup key={key} group={part} />;
				}
				if (isToolCallPart(part)) {
					if (isCursorSubagentToolName(part.toolName)) {
						// Cursor subagent invocation (`task` → `cursor_task`) —
						// dedicated renderer with model/mode chips + agentId
						// color identity + expandable prompt/result body.
						return (
							<CursorSubagentToolCall key={key} part={part as ToolCallPart} />
						);
					}
					if (isSubagentToolName(part.toolName)) {
						// Sub-agent collab tools (spawn / wait / send / resume /
						// close) — multi-line layout in a dedicated component.
						// `subagent_spawn` only reaches here for *isolated*
						// spawns; consecutive spawns are folded into a
						// SubAgentSpawnGroup above.
						return <SubAgentToolCall key={key} part={part as ToolCallPart} />;
					}
					return (
						<AssistantToolCall
							key={key}
							toolName={part.toolName}
							args={part.args}
							result={part.result}
							isError={
								part.toolName === "ExitPlanMode"
									? false
									: (part as ToolCallPart).isError
							}
							streamingStatus={(part as ToolCallPart).streamingStatus}
							childParts={(part as ToolCallPart).children}
						/>
					);
				}
				if (isTodoListPart(part)) {
					return <TodoList key={key} part={part} />;
				}
				if (isImagePart(part)) {
					return <ImageBlock key={key} part={part} />;
				}
				if (isPlanReviewPart(part)) {
					return <PlanReviewCard key={key} part={part} />;
				}
				return null;
			})}
			{!streaming && message.status?.type === "incomplete" ? (
				<MessageStatusBadge reason={message.status.reason} />
			) : null}
		</div>
	);
}
