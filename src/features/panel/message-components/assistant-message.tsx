import { AlertCircle, AlertTriangle, Clock3, Info } from "lucide-react";
import { memo, Suspense } from "react";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai/reasoning";
import type { ExtendedMessagePart, ToolCallPart } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ImageBlock, PlanReviewCard, TodoList } from "./content-parts";
import type { RenderedMessage, StreamdownMode } from "./shared";
import {
	isCollapsedGroupPart,
	isImagePart,
	isPlanReviewPart,
	isReasoningPart,
	isTextPart,
	isTodoListPart,
	isToolCallPart,
} from "./shared";
import { LazyStreamdown } from "./streamdown-loader";
import { AssistantToolCall, CollapsedToolGroup } from "./tool-call";

// --- AssistantText ---

const STREAMING_ANIMATED = {
	animation: "blurIn" as const,
	duration: 150,
	easing: "linear" as const,
	sep: "word" as const,
	stagger: 30,
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

	return (
		<div
			className="conversation-markdown assistant-markdown-scale max-w-none break-words text-foreground"
			style={{ fontSize: `${Math.max(settings.fontSize - 1, 12)}px` }}
		>
			<Suspense fallback={<AssistantTextFallback text={text} />}>
				<LazyStreamdown
					animated={streaming ? STREAMING_ANIMATED : false}
					caret={undefined}
					className="conversation-streamdown"
					isAnimating={streaming}
					mode={mode}
				>
					{text}
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

	return (
		<div
			data-message-id={message.id}
			data-message-role="assistant"
			className="flex min-w-0 max-w-full flex-col gap-1"
		>
			{parts.map((part, index) => {
				if (isTextPart(part)) {
					return (
						<AssistantText
							key={`text:${index}`}
							text={part.text}
							streaming={streaming}
						/>
					);
				}
				if (isReasoningPart(part)) {
					return (
						<Reasoning
							key={`reasoning:${index}`}
							isStreaming={part.streaming === true}
						>
							<ReasoningTrigger />
							<ReasoningContent fontSize={settings.fontSize}>
								{part.text}
							</ReasoningContent>
						</Reasoning>
					);
				}
				if (isCollapsedGroupPart(part)) {
					return (
						<CollapsedToolGroup
							key={`group-${part.tools[0]?.toolCallId ?? index}`}
							group={part}
						/>
					);
				}
				if (isToolCallPart(part)) {
					return (
						<AssistantToolCall
							key={`tc:${part.toolCallId ?? `${part.toolName}:${index}`}`}
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
					return <TodoList key={`todo:${index}`} part={part} />;
				}
				if (isImagePart(part)) {
					return <ImageBlock key={`img:${index}`} part={part} />;
				}
				if (isPlanReviewPart(part)) {
					return (
						<PlanReviewCard
							key={`plan-review:${part.toolUseId}:${index}`}
							part={part}
						/>
					);
				}
				return null;
			})}
			{!streaming && message.status?.type === "incomplete" ? (
				<MessageStatusBadge reason={message.status.reason} />
			) : null}
		</div>
	);
}
