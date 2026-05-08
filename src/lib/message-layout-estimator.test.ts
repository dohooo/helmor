import { describe, expect, it } from "vitest";
import type { ReasoningPart, ThreadMessageLike, ToolCallPart } from "./api";
import { estimateThreadRowHeights } from "./message-layout-estimator";

function makeTool(index: number): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: `tool-${index}`,
		toolName: "Bash",
		args: { command: `sed -n '${index},${index + 8}p' src/file.ts` },
		argsText: "",
		result: index % 2 === 0 ? "line 1\nline 2\nline 3" : undefined,
		streamingStatus: index === 3 ? "running" : "done",
	};
}

function makeReasoning(
	index: number,
	streaming: boolean | undefined,
): ReasoningPart {
	return {
		type: "reasoning",
		id: `reasoning-${index}`,
		text: `Reasoning step ${index}: ${"detailed thought ".repeat(60)}`,
		streaming,
	};
}

describe("estimateThreadRowHeights", () => {
	it("reserves expanded height for collapsed tool groups", () => {
		const messages: ThreadMessageLike[] = [
			{
				id: "assistant-streaming",
				role: "assistant",
				streaming: true,
				content: [
					{ type: "text", id: "text-1", text: "Streaming response" },
					{
						type: "collapsed-group",
						id: "group-1",
						category: "shell",
						active: true,
						summary: "Running 4 read-only commands...",
						tools: Array.from({ length: 4 }, (_, index) => makeTool(index)),
					},
				],
			},
		];

		const [height] = estimateThreadRowHeights(messages, {
			fontSize: 14,
			paneWidth: 960,
		});

		expect(height).toBeGreaterThan(150);
	});

	// Regression: previous estimator treated `just-finished` reasoning as
	// expanded, but the `Reasoning` component renders it collapsed (default
	// closed for non-streaming, with auto-collapse on the live transition).
	// The mismatch inflated `totalRowsHeight` by ~textHeight per reasoning,
	// producing a multi-screen gap below the last visible content.
	it("treats just-finished reasoning as collapsed", () => {
		const justFinishedRow: ThreadMessageLike = {
			id: "assistant-just-finished",
			role: "assistant",
			streaming: true,
			content: [
				{ type: "text", id: "leading", text: "Working on it." },
				...Array.from({ length: 8 }, (_, index) => makeReasoning(index, false)),
				{
					type: "tool-call",
					toolCallId: "tool-final",
					toolName: "Read",
					args: { file_path: "/some/path.ts" },
					argsText: "",
					streamingStatus: "running",
				},
			],
		};

		const [collapsedHeight] = estimateThreadRowHeights([justFinishedRow], {
			fontSize: 14,
			paneWidth: 960,
		});

		// Same row, but reasoning blocks are still actively streaming. They
		// should be measured as expanded — that's the legitimately tall
		// case.
		const streamingReasoningRow: ThreadMessageLike = {
			...justFinishedRow,
			content: justFinishedRow.content.map((part) =>
				part.type === "reasoning" ? makeReasoning(0, true) : part,
			),
		};
		const [streamingHeight] = estimateThreadRowHeights(
			[streamingReasoningRow],
			{ fontSize: 14, paneWidth: 960 },
		);

		// Each just-finished reasoning collapses to ~24px; expanded reasoning
		// is hundreds of px tall, so the streaming variant should dominate.
		expect(streamingHeight).toBeGreaterThan(collapsedHeight + 200);
		// And the just-finished row should be on the order of (parts × 24px),
		// not (parts × textHeight).
		expect(collapsedHeight).toBeLessThan(400);
	});

	it("treats historical reasoning as collapsed", () => {
		const historical: ThreadMessageLike = {
			id: "assistant-historical",
			role: "assistant",
			content: Array.from({ length: 6 }, (_, index) =>
				makeReasoning(index, undefined),
			),
		};
		const [height] = estimateThreadRowHeights([historical], {
			fontSize: 14,
			paneWidth: 960,
		});
		// 6 collapsed reasoning summaries plus gaps and bottom padding.
		expect(height).toBeLessThan(300);
	});
});
