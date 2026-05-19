import { useEffect, useMemo, useState } from "react";
import {
	ActiveThreadViewport,
	type PresentedSessionPane,
} from "@/features/panel/thread-viewport";
import type {
	CollapsedGroupPart,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";

const SESSION_ID = "e2e-streaming-footer-overlap";
const TOOL_STEPS = 18;

function makeTool(toolIndex: number): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: `tool-${toolIndex}`,
		toolName: "Bash",
		args: {
			command: `sed -n '${toolIndex},${toolIndex + 8}p' src/features/panel/thread-viewport.tsx`,
		},
		argsText: "",
		result:
			toolIndex % 2 === 0
				? `line ${toolIndex}\nline ${toolIndex + 1}\nline ${toolIndex + 2}`
				: undefined,
		streamingStatus: toolIndex === TOOL_STEPS - 1 ? "running" : "done",
	};
}

function makeCollapsedGroup(visibleTools: number): CollapsedGroupPart {
	return {
		type: "collapsed-group",
		id: "group-shell-tools",
		category: "shell",
		active: true,
		summary: `Running ${visibleTools} read-only commands...`,
		tools: Array.from({ length: visibleTools }, (_, index) => makeTool(index)),
	};
}

function makeFillerMessage(index: number): ThreadMessageLike {
	return {
		id: `filler-${index}`,
		role: index % 3 === 0 ? "user" : "assistant",
		content:
			index % 3 === 0
				? [
						{
							type: "text",
							id: `filler-${index}-text`,
							text: `Filler prompt ${index}: keep this thread long enough to force virtualization.`,
						},
					]
				: [
						{
							type: "text",
							id: `filler-${index}-reply`,
							text: `Historical reply ${index}. This row exists only to push the panel past the non-virtualized threshold.`,
						},
					],
	};
}

function buildMessages(visibleTools: number): ThreadMessageLike[] {
	const history = Array.from({ length: 14 }, (_, index) =>
		makeFillerMessage(index),
	);
	return [
		...history,
		{
			id: "streaming-assistant",
			role: "assistant",
			streaming: true,
			content: [
				{
					type: "text",
					id: "streaming-text",
					text: "Got the smoking-gun evidence: it's gone.",
				},
				makeCollapsedGroup(visibleTools),
			],
		},
	];
}

export function StreamingFooterOverlapScenario() {
	const [visibleTools, setVisibleTools] = useState(2);

	useEffect(() => {
		const intervalId = window.setInterval(() => {
			setVisibleTools((current) =>
				current >= TOOL_STEPS ? TOOL_STEPS : current + 1,
			);
		}, 140);
		return () => window.clearInterval(intervalId);
	}, []);

	const pane = useMemo<PresentedSessionPane>(
		() => ({
			sessionId: SESSION_ID,
			messages: buildMessages(visibleTools),
			sending: true,
			hasLoaded: true,
			presentationState: "presented",
		}),
		[visibleTools],
	);

	return (
		<div className="flex h-screen flex-col bg-background text-foreground">
			<div className="border-b border-border/50 px-4 py-3">
				<h1 className="text-sm font-medium">
					Streaming Footer Overlap Scenario
				</h1>
				<p className="text-xs text-muted-foreground">
					Virtualized thread + expanding collapsed tool group + active footer
				</p>
			</div>
			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center gap-2 border-b border-border/40 px-4 py-2 text-xs text-muted-foreground">
						<span data-testid="visible-tool-count">{visibleTools}</span>
						<span>visible tools</span>
					</div>
					<ActiveThreadViewport hasSession pane={pane} />
				</div>
			</div>
		</div>
	);
}
