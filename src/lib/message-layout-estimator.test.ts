import { describe, expect, it } from "vitest";
import type { ReasoningPart, ThreadMessageLike, ToolCallPart } from "./api";
import {
	estimateThreadRowHeights,
	measureTextHeight,
} from "./message-layout-estimator";

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

// A ~560-line pre-wrap pasted-code USER message that exercises BOTH estimator
// fixes the height path depends on:
//   1. break-word line counting on a single 2961-char unbroken token (the
//      pretext upgrade lever), and
//   2. tab-indented lines (the tab-size-4 normalization lever).
// This is the load-bearing heavy-message fixture: the bottom anchor on a heavy
// switch is a sum of per-row estimates, so this one giant row must be accurate.
function buildGiantUserMessageText(): string {
	const lines: string[] = [];
	// One unbroken 2961-char token. Empirically (real Geist, 14px, bubbleWidth
	// 562, tab-size 4) this wraps to 41 browser lines — the break-word case.
	lines.push("x".repeat(2961));
	// Tab-indented source lines (two leading tabs) — exercises tab expansion.
	for (let index = 0; index < 40; index += 1) {
		lines.push(
			`\t\tconst value${index} = computeSomethingWithAModeratelyLongName(argumentOne, argumentTwo, argumentThree);`,
		);
	}
	// Filler source lines to reach ~560 total, a few wrap at the bubble width.
	let filler = 0;
	while (lines.length < 560) {
		lines.push(
			`    // line ${filler}: some pasted source code content that is reasonably wide but wraps occasionally in the bubble width here`,
		);
		filler += 1;
	}
	return lines.join("\n");
}

function makeUserMessage(text: string): ThreadMessageLike {
	return {
		id: "user-giant",
		role: "user",
		content: [{ type: "text", id: "user-giant-text", text }],
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

	// A user message over the composer badge threshold (500 trimmed chars — the
	// same gate that turns a large paste into a tag in the composer) renders
	// collapsed as a fixed-height chip row, so its estimate is a constant. This
	// is what keeps giant pasted messages out of both the pretext layout AND the
	// mounted DOM on a session switch.
	it("estimates over-threshold user messages at a fixed collapsed height", () => {
		const [medium] = estimateThreadRowHeights(
			[makeUserMessage("x".repeat(600))],
			{ fontSize: 14, paneWidth: 822 },
		);
		const [giant] = estimateThreadRowHeights(
			[makeUserMessage(buildGiantUserMessageText())],
			{ fontSize: 14, paneWidth: 822 },
		);

		// Size-invariant: a 600-char and a ~67k-char message price identically.
		expect(giant).toBe(medium);
		expect(giant).toBeLessThan(120);
	});

	it("keeps sub-threshold user messages on the measured path", () => {
		const [short] = estimateThreadRowHeights(
			[makeUserMessage("short prompt")],
			{
				fontSize: 14,
				paneWidth: 822,
			},
		);
		const [wrapped] = estimateThreadRowHeights(
			[makeUserMessage("x".repeat(480))],
			{ fontSize: 14, paneWidth: 822 },
		);

		// Under the threshold the height still tracks the text (a 480-char
		// unbroken token wraps to several lines; a short prompt is one line).
		expect(wrapped).toBeGreaterThan(short);
	});
});

// The pre-wrap text-measurement gates. These used to run through a giant USER
// message row, but over-threshold user messages now estimate to the collapsed
// constant — the measurement path they lock (break-word counting + tab-size-4
// normalization) is still live for assistant markdown, reasoning bodies, plan
// reviews, and sub-threshold user text, so the gates target measureTextHeight
// directly with the user-bubble geometry they were calibrated against.
describe("measureTextHeight (pre-wrap accuracy gates)", () => {
	// Geometry mirrors the live app exactly: fontSize 14, paneWidth 822 →
	// contentWidth 782 → bubbleWidth floor(782*0.75)-24 = 562; user-bubble
	// line-height 28.
	const userBubbleGeometry = {
		fontSize: 14,
		lineHeight: 28,
		maxWidth: 562,
		whiteSpace: "pre-wrap",
	} as const;

	// Target: the EMPIRICALLY-MEASURED real-Geist DOM height of this exact text
	// rendered in the live user-bubble layer (`<p class="whitespace-pre-wrap
	// break-words">`, tab-size 4) — a 32452px row, captured via the Tauri MCP
	// bridge in the running debug app, minus the row's fixed chrome (16px bubble
	// vertical padding + 6px row shell bottom padding) = 32430px of text.
	//
	// The ±2% bound is a genuine red→green gate for the tab-size-4 normalization:
	// WITH it the text measures 32508px (+0.24% vs DOM, green); WITHOUT it
	// pretext's default tab-size-8 over-counts the 40 tab-indented lines (+3.7%,
	// red). The pretext 0.0.4→0.0.7 bump does NOT move this number — for this
	// content shape both versions agree, in vitest (8px/char canvas stub) and
	// in-app (real Geist: the lone 2961-char token wraps to 44 lines in both).
	it("measures the giant pre-wrap text within 2% of measured DOM", () => {
		const measured = measureTextHeight(
			buildGiantUserMessageText(),
			userBubbleGeometry,
		);

		const measuredDomTextHeightPx = 32430;
		const relativeError =
			Math.abs(measured - measuredDomTextHeightPx) / measuredDomTextHeightPx;
		expect(relativeError).toBeLessThanOrEqual(0.02);
	});

	// Tab faithfulness: pretext defaults to tab-size 8, the live pre-wrap bubble
	// renders tab-size 4. The estimator expands leading tabs to 4-column stops
	// before measuring, so tab-indented text must measure the SAME height as the
	// equivalent 4-space-indented text. Without the normalization the tab
	// variant would over-count (pretext treating each tab as 8 columns).
	it("measures leading-tab text equal to 4-space-indented text", () => {
		const body = Array.from(
			{ length: 60 },
			(_, index) =>
				`renderRowWithAReasonablyDescriptiveFunctionName(item${index}, options, context);`,
		);
		const tabbed = body.map((line) => `\t${line}`).join("\n");
		const spaced = body.map((line) => `    ${line}`).join("\n");

		const tabbedHeight = measureTextHeight(tabbed, userBubbleGeometry);
		const spacedHeight = measureTextHeight(spaced, userBubbleGeometry);

		expect(Math.abs(tabbedHeight - spacedHeight)).toBeLessThanOrEqual(1);
	});
});
