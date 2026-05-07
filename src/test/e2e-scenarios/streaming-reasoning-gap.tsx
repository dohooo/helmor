import { useEffect, useMemo, useState } from "react";
import {
	ActiveThreadViewport,
	type PresentedSessionPane,
} from "@/features/panel/thread-viewport";
import type {
	ExtendedMessagePart,
	ReasoningPart,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";

// Reproduces the bottom-gap bug.
//
// Root hypothesis: when a streaming assistant row contains many reasoning
// parts, the auto-collapse in `<Reasoning>` shrinks the DOM while the
// estimator still treats `just-finished` as expanded — so
// `Math.max(measured, estimated)` for the streaming row inflates by the
// full collapsed-vs-expanded delta (~textHeight per reasoning), and the
// resulting `totalRowsHeight` produces a huge gap below the last visible
// content.
//
// Scenario walks one reasoning at a time:
//   step 0..N-1   reasoning N is streaming, 0..N-1 are just-finished
//   final tool    a tool_use is appended after the last reasoning, mirroring
//                 the user's "突然多了一个工具调用" trigger

const SESSION_ID = "e2e-streaming-reasoning-gap";
const HISTORY_COUNT = 16;
const REASONING_STEPS = 10;
const REASONING_TEXT = [
	"The user is asking about the bottom-gap bug. Let me trace the layout pipeline first.",
	"Looking at thread-viewport.tsx, totalRowsHeight is derived from absolute-positioned rows.",
	"The estimator is in src/lib/message-layout-estimator.ts — it's keyed by message reference.",
	"resolveConversationRowHeight does Math.max(measured, estimated) when streaming === true.",
	"reasoning-lifecycle.ts maps wire-format streaming tri-state to UI state.",
	"Reasoning component auto-collapses on streaming → not-streaming transition.",
	"So the DOM state for just-finished is collapsed, but the estimator says expanded.",
	"That's the mismatch — accumulated across many reasoning blocks it dwarfs the viewport.",
	"Need to either: pessimistically estimate just-finished, or align the DOM by always collapsing.",
	"Going with estimator change first; it's the safer fix and Math.max protects against undershoot.",
].map(
	(line, index) =>
		// Pad each line so reasoning blocks are large enough to expose the gap.
		`${line} ${"Padding sentence to make reasoning text visibly tall. ".repeat(8)}\n\nDeep dive #${index + 1}: ${"more diagnostic text ".repeat(20)}`,
);

function makeFiller(index: number): ThreadMessageLike {
	const role = index % 3 === 0 ? "user" : "assistant";
	if (role === "user") {
		return {
			id: `filler-user-${index}`,
			role: "user",
			content: [
				{
					type: "text",
					id: `filler-user-${index}-text`,
					text: `Question ${index}: keep the thread long enough to virtualize.`,
				},
			],
		};
	}
	return {
		id: `filler-assistant-${index}`,
		role: "assistant",
		content: [
			{
				type: "text",
				id: `filler-assistant-${index}-text`,
				text: `Reply ${index}. Historical content padding the scrollback.`,
			},
		],
	};
}

function makeReasoningPart(index: number, streaming: boolean): ReasoningPart {
	return {
		type: "reasoning",
		id: `reasoning-${index}`,
		text: REASONING_TEXT[index] ?? `Reasoning step ${index}`,
		streaming,
		durationMs: streaming ? undefined : 4_500,
	};
}

function makeFinalTool(): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: "final-tool",
		toolName: "Read",
		args: {
			file_path: "/Users/me/repo/src/lib/message-layout-estimator.ts",
		},
		argsText: "",
		streamingStatus: "running",
	};
}

function buildStreamingParts(
	stepIndex: number,
	includeTool: boolean,
): ExtendedMessagePart[] {
	const parts: ExtendedMessagePart[] = [
		{
			type: "text",
			id: "leading-text",
			text: "Working through this layered virtualization question now.",
		},
	];
	for (let i = 0; i <= stepIndex; i += 1) {
		const isLast = i === stepIndex;
		parts.push(makeReasoningPart(i, isLast && !includeTool));
	}
	if (includeTool) {
		parts.push(makeFinalTool());
	}
	return parts;
}

function buildMessages(
	stepIndex: number,
	includeTool: boolean,
): ThreadMessageLike[] {
	const history = Array.from({ length: HISTORY_COUNT }, (_, index) =>
		makeFiller(index),
	);
	return [
		...history,
		{
			id: "streaming-assistant",
			role: "assistant",
			streaming: true,
			content: buildStreamingParts(stepIndex, includeTool),
		},
	];
}

export function StreamingReasoningGapScenario() {
	// 0..REASONING_STEPS-1: reasoning N is streaming (others just-finished)
	// REASONING_STEPS:      tool call appended; all reasoning is just-finished
	const [stepIndex, setStepIndex] = useState(0);
	const [autoAdvance, setAutoAdvance] = useState(true);
	// `remountKey` simulates "user switched away and back": the viewport
	// remounts with messages already in their current lifecycle state, so
	// every Reasoning block mounts fresh as `just-finished` and the
	// auto-collapse useEffect cannot observe a `streaming → !streaming`
	// transition. This is the case the user is asking us to verify.
	const [remountKey, setRemountKey] = useState(0);

	useEffect(() => {
		if (!autoAdvance) {
			return;
		}
		const intervalId = window.setInterval(() => {
			setStepIndex((current) =>
				current >= REASONING_STEPS ? current : current + 1,
			);
		}, 1500);
		return () => window.clearInterval(intervalId);
	}, [autoAdvance]);

	const includeTool = stepIndex >= REASONING_STEPS;

	const pane = useMemo<PresentedSessionPane>(
		() => ({
			sessionId: SESSION_ID,
			messages: buildMessages(
				Math.min(stepIndex, REASONING_STEPS - 1),
				includeTool,
			),
			sending: true,
			hasLoaded: true,
			presentationState: "presented",
		}),
		[stepIndex, includeTool],
	);

	return (
		<div className="flex h-screen flex-col bg-background text-foreground">
			<div className="flex items-center gap-3 border-b border-border/50 px-4 py-2 text-xs">
				<span className="font-medium">Streaming Reasoning Gap</span>
				<span className="text-muted-foreground">
					step <span data-testid="step-index">{stepIndex}</span> /{" "}
					{REASONING_STEPS}
				</span>
				<span className="text-muted-foreground">
					{includeTool ? "tool appended" : "reasoning only"}
				</span>
				<button
					type="button"
					className="rounded border border-border/40 px-2 py-0.5 hover:bg-accent"
					onClick={() => {
						setAutoAdvance((current) => !current);
					}}
				>
					{autoAdvance ? "pause" : "resume"}
				</button>
				<button
					type="button"
					className="rounded border border-border/40 px-2 py-0.5 hover:bg-accent"
					onClick={() => {
						setStepIndex(0);
					}}
				>
					reset
				</button>
				<button
					type="button"
					className="rounded border border-border/40 px-2 py-0.5 hover:bg-accent"
					onClick={() => {
						setStepIndex((current) => Math.min(REASONING_STEPS, current + 1));
					}}
				>
					next
				</button>
				<button
					type="button"
					className="rounded border border-accent-foreground/40 bg-accent/40 px-2 py-0.5 hover:bg-accent"
					data-testid="remount"
					onClick={() => {
						setRemountKey((current) => current + 1);
					}}
				>
					switch-away/back (remount)
				</button>
				<span className="text-muted-foreground">
					remount=<span data-testid="remount-key">{remountKey}</span>
				</span>
			</div>
			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 flex-col">
					<ActiveThreadViewport
						key={`pane-${remountKey}`}
						hasSession
						pane={pane}
					/>
				</div>
			</div>
		</div>
	);
}
