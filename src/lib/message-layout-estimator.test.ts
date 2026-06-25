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

function makeAssistantMessage(text: string): ThreadMessageLike {
	return {
		id: "assistant-md",
		role: "assistant",
		content: [{ type: "text", id: "assistant-md-text", text }],
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

	// A pasted-text tag renders as a one-line chip (hover previews the
	// content), so the estimator prices it as a single line — the paste's
	// text never reaches the pretext layout. This is what keeps a giant
	// paste out of both the layout estimation AND the mounted DOM.
	it("estimates pasted-text parts as one line regardless of content size", () => {
		const makePastedMessage = (pasteText: string): ThreadMessageLike => ({
			id: "user-pasted",
			role: "user",
			content: [
				{ type: "text", id: "t0", text: "请看这段:\n" },
				{ type: "pasted-text", id: "p0", text: pasteText },
			],
		});

		const [small] = estimateThreadRowHeights(
			[makePastedMessage("x".repeat(600))],
			{ fontSize: 14, paneWidth: 822 },
		);
		const [giant] = estimateThreadRowHeights(
			[makePastedMessage(buildGiantUserMessageText())],
			{ fontSize: 14, paneWidth: 822 },
		);
		const [inlined] = estimateThreadRowHeights(
			[makeUserMessage(buildGiantUserMessageText())],
			{ fontSize: 14, paneWidth: 822 },
		);

		// Chip pricing is size-invariant…
		expect(giant).toBe(small);
		// …and tiny next to the same content inlined as plain text (which
		// itself is line-clamped, so it prices at the 20-line cap).
		expect(giant).toBeLessThan(200);
		expect(inlined).toBeGreaterThan(giant);
	});

	// Messages taller than the visual-line cap render line-clamped with a
	// Show-more control (see ChatUserMessage), so the estimator prices them
	// at the clamped height — invariant to how far past the cap they go.
	it("caps over-the-cap user messages at the clamped height", () => {
		const lines = (n: number) =>
			Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

		const [at30] = estimateThreadRowHeights([makeUserMessage(lines(30))], {
			fontSize: 14,
			paneWidth: 822,
		});
		const [at300] = estimateThreadRowHeights([makeUserMessage(lines(300))], {
			fontSize: 14,
			paneWidth: 822,
		});
		const [at20] = estimateThreadRowHeights([makeUserMessage(lines(20))], {
			fontSize: 14,
			paneWidth: 822,
		});
		const [at10] = estimateThreadRowHeights([makeUserMessage(lines(10))], {
			fontSize: 14,
			paneWidth: 822,
		});

		expect(at300).toBe(at30);
		// Under the cap the height still tracks the content.
		expect(at20).toBeGreaterThan(at10);
		expect(at30).toBeGreaterThan(at20);
	});

	// The cap is VISUAL lines, not newlines: a single unbroken paragraph that
	// wraps past the cap prices the same as one full of hard newlines. (This
	// was the original bug — a newline-free CJK paragraph wrapped to dozens
	// of lines but never hit a source-line counter.)
	it("caps a single unbroken paragraph that wraps past the cap", () => {
		const [wrapped2k] = estimateThreadRowHeights(
			[makeUserMessage("x".repeat(2000))],
			{ fontSize: 14, paneWidth: 822 },
		);
		const [wrapped8k] = estimateThreadRowHeights(
			[makeUserMessage("x".repeat(8000))],
			{ fontSize: 14, paneWidth: 822 },
		);
		const [hardLines] = estimateThreadRowHeights(
			[
				makeUserMessage(
					Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
				),
			],
			{ fontSize: 14, paneWidth: 822 },
		);

		expect(wrapped8k).toBe(wrapped2k);
		expect(wrapped2k).toBe(hardLines);
	});

	// Accuracy lock for the scroll-stop "shake": a one-line user row measures
	// 70px on the live DOM = 28 (line) + 16 (bubble padding) + 20 (action gutter)
	// + 6 (row shell). Omitting the action gutter regressed every user row to
	// 50px, so each popped down 20px the moment its measured height committed.
	it("prices a one-line user message at the live-measured 70px", () => {
		const [height] = estimateThreadRowHeights([makeUserMessage("hi")], {
			fontSize: 14,
			paneWidth: 822,
		});
		expect(height).toBe(70);
	});

	// A fenced language renders a ~30px header bar (language label + copy/download
	// actions); a bare ``` block does not. The estimator must add the header only
	// when a language is present, or code-heavy assistant rows mis-estimate and
	// pop on measurement.
	it("adds the code-block header height only when a language is fenced", () => {
		const code = "const value = compute();\nreturn value;";
		const [withLang] = estimateThreadRowHeights(
			[makeAssistantMessage(`\`\`\`ts\n${code}\n\`\`\``)],
			{ fontSize: 14, paneWidth: 960 },
		);
		const [noLang] = estimateThreadRowHeights(
			[makeAssistantMessage(`\`\`\`\n${code}\n\`\`\``)],
			{ fontSize: 14, paneWidth: 960 },
		);
		expect(withLang - noLang).toBe(30);
	});
});

// The pre-wrap text-measurement gates. The giant fixture used to flow through
// a user message row; pasted tags now carve such content out into one-line
// chip parts, but the measurement path these gates lock (break-word counting
// + tab-size-4 normalization) is still live for assistant markdown, reasoning
// bodies, plan reviews, and any user text NOT marked as a pasted tag (typed
// bulk, historical messages) — so they target measureTextHeight directly with
// the user-bubble geometry they were calibrated against.
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
