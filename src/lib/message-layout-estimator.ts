import { layout, type PreparedText, prepare } from "@chenglou/pretext";
import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	MessagePart,
	PlanReviewPart,
	ReasoningPart,
	ThreadMessageLike,
	ToolCallPart,
} from "./api";
import { measureSync } from "./perf-marks";
import { reasoningLifecycle } from "./reasoning-lifecycle";

type EstimateOptions = {
	fontSize: number;
	paneWidth: number;
};

const ROW_SHELL_BOTTOM_PADDING = 6;
const ASSISTANT_PART_GAP = 4;
const ASSISTANT_LINE_HEIGHT = 24;
const USER_LINE_HEIGHT = 28;
const SYSTEM_LINE_HEIGHT = 18;
const TOOL_SUMMARY_HEIGHT = 24;
const REASONING_SUMMARY_HEIGHT = 24;
// Chrome around the expanded reasoning body: trigger (~28px), CollapsibleContent
// top padding (6px), and the <pre>'s px-3/py-2.5 so together we match what
// `ReasoningContent` actually renders in `src/components/ai/reasoning.tsx`.
const REASONING_EXPANDED_CHROME_HEIGHT = 50;
const REASONING_EXPANDED_CONTENT_HORIZONTAL_PADDING = 24;
const COLLAPSED_GROUP_HEIGHT = 24;
const USER_BUBBLE_VERTICAL_PADDING = 16;
const USER_BUBBLE_HORIZONTAL_PADDING = 24;
const USER_BUBBLE_WIDTH_RATIO = 0.75;
// A user message taller than this many VISUAL lines renders line-clamped
// with a "Show more" control (see ChatUserMessage — the browser reports the
// actual truncation, so wrapped paragraphs count the same as hard newlines).
// Exported so the renderer's clamp and the estimator share one constant: the
// estimator prices an over-cap row at the clamped height — expanding happens
// on a mounted row, where the real measurement takes over, so expansion
// state never reaches the estimator.
export const USER_MESSAGE_CLAMP_LINES = 20;
// The "Show more" control row under the clamped text.
const USER_CLAMP_CONTROL_HEIGHT = 28;
const MIN_TEXT_WIDTH = 64;
const MARKDOWN_BLOCK_GAP = 12;
const MARKDOWN_HEADING_MARGIN_TOP = 10;
const MARKDOWN_HEADING_MARGIN_BOTTOM = 8;
const MARKDOWN_CODE_BLOCK_PADDING = 28;
const MARKDOWN_CODE_LINE_HEIGHT = 22;
const MARKDOWN_TABLE_TOOLBAR_HEIGHT = 32;
const MARKDOWN_TABLE_ROW_HEIGHT = 40;
const MARKDOWN_QUOTE_PADDING = 12;

/**
 * Bounded LRU cache for `prepare()` results. Without a cap this Map grows
 * forever in long-lived desktop sessions, since each new font/text combination
 * (including streaming partials) becomes a new entry. JS Map preserves
 * insertion order, so we can implement LRU by deleting + re-inserting on hit
 * and trimming the oldest entries when over capacity.
 */
const PREPARED_TEXT_CACHE_LIMIT = 2000;
const preparedTextCache = new Map<string, PreparedText>();

/**
 * Per-message height memoization keyed by message reference. Static messages
 * keep the same reference across stream ticks, so a cache hit lets us skip the
 * `prepare()`/`layout()` traversal entirely. The streaming message gets a new
 * reference every tick — cache misses for that one are correct.
 *
 * WeakMap so the entry is garbage collected when the message object is dropped
 * (e.g. user switches sessions and the old thread snapshot is released).
 */
type MessageHeightCacheEntry = {
	fontSize: number;
	contentWidth: number;
	height: number;
};
const messageHeightCache = new WeakMap<
	ThreadMessageLike,
	MessageHeightCacheEntry
>();

export function estimateThreadRowHeights(
	messages: ThreadMessageLike[],
	options: EstimateOptions,
): number[] {
	return measureSync(
		"estimator:thread-heights",
		() => {
			const contentWidth = Math.max(MIN_TEXT_WIDTH, options.paneWidth - 40);
			let cacheHits = 0;
			let cacheMisses = 0;

			const heights = messages.map((message) => {
				const cached = messageHeightCache.get(message);
				if (
					cached &&
					cached.fontSize === options.fontSize &&
					cached.contentWidth === contentWidth
				) {
					cacheHits += 1;
					return cached.height;
				}
				cacheMisses += 1;
				const height = estimateMessageRowHeight(message, {
					fontSize: options.fontSize,
					contentWidth,
				});
				messageHeightCache.set(message, {
					fontSize: options.fontSize,
					contentWidth,
					height,
				});
				return height;
			});

			// Stash the most recent hit/miss tally on the function so the perf
			// dashboard can read it without re-running. (Cheap, dev-only path.)
			estimateThreadRowHeights.lastCacheHits = cacheHits;
			estimateThreadRowHeights.lastCacheMisses = cacheMisses;

			return heights;
		},
		{ messageCount: messages.length },
	);
}

estimateThreadRowHeights.lastCacheHits = 0;
estimateThreadRowHeights.lastCacheMisses = 0;

function estimateMessageRowHeight(
	message: ThreadMessageLike,
	options: { fontSize: number; contentWidth: number },
) {
	switch (message.role) {
		case "assistant":
			return estimateAssistantMessageHeight(message, options);
		case "user":
			return estimateUserMessageHeight(message, options);
		default:
			return estimateSystemMessageHeight(message, options);
	}
}

function estimateAssistantMessageHeight(
	message: ThreadMessageLike,
	options: { fontSize: number; contentWidth: number },
) {
	const parts = message.content as ExtendedMessagePart[];
	const partHeights = parts
		.map((part) => estimateAssistantPartHeight(part, options))
		.filter((height) => height > 0);

	if (partHeights.length === 0) {
		return REASONING_SUMMARY_HEIGHT + ROW_SHELL_BOTTOM_PADDING;
	}

	const partsHeight = partHeights.reduce((sum, height) => sum + height, 0);
	const gapsHeight = ASSISTANT_PART_GAP * Math.max(0, partHeights.length - 1);
	return partsHeight + gapsHeight + ROW_SHELL_BOTTOM_PADDING;
}

function estimateAssistantPartHeight(
	part: ExtendedMessagePart,
	options: { fontSize: number; contentWidth: number },
) {
	switch (part.type) {
		case "text":
			return estimateAssistantTextHeight(part.text, options);
		case "reasoning":
			return estimateReasoningHeight(part, options);
		case "tool-call":
			return estimateToolCallHeight(part);
		case "collapsed-group":
			return estimateCollapsedGroupHeight(part);
		case "todo-list":
			// Header (~22px) + per-row line-height (24px) + padding.
			return 22 + part.items.length * 24 + 16;
		case "workflow":
			// Header (~22px) + per-agent rows (24px) + footer (~18px) + padding.
			return 22 + (part.agents?.length ?? 0) * 24 + 18 + 16;
		case "image":
			// Cap matches the rendered max-height; small slack for margin.
			return 440;
		case "plan-review":
			return estimatePlanReviewHeight(part, options);
		default:
			return TOOL_SUMMARY_HEIGHT;
	}
}

/**
 * Reasoning has two height regimes, matching what `ReasoningContent`
 * actually renders:
 *
 *   - `streaming` → expanded → trigger + chrome + wrapped text height.
 *   - `just-finished` and `historical` → collapsed → just the trigger
 *     (~24px). The `Reasoning` component now defaults `just-finished`
 *     blocks closed (matching `historical`), so the DOM is the same
 *     whether the user watched the stream finish or switched away and
 *     came back. Aligning the estimate with that DOM keeps the
 *     streaming row's `max(measured, estimated)` from inflating
 *     `totalRowsHeight` — the source of the bottom gap below the last
 *     visible content.
 */
function estimateReasoningHeight(
	part: ReasoningPart,
	options: { fontSize: number; contentWidth: number },
) {
	// Empty body (e.g. Claude Thinking Display = Omitted) renders flat.
	if (
		reasoningLifecycle(part) !== "streaming" ||
		part.text.trim().length === 0
	) {
		return REASONING_SUMMARY_HEIGHT;
	}
	const bodyWidth = Math.max(
		MIN_TEXT_WIDTH,
		options.contentWidth - REASONING_EXPANDED_CONTENT_HORIZONTAL_PADDING,
	);
	// Streaming row is mounted, so ResizeObserver feeds the real height back.
	// Skip the per-tick `prepare()` + `layout()` cost (cache miss every frame
	// since the text grows) and use the cheap fallback estimate as a placeholder.
	const textHeight = fallbackTextHeight(part.text, {
		fontSize: options.fontSize,
		lineHeight: ASSISTANT_LINE_HEIGHT,
		maxWidth: bodyWidth,
		whiteSpace: "pre-wrap",
	});
	return REASONING_EXPANDED_CHROME_HEIGHT + textHeight;
}

function estimatePlanReviewHeight(
	part: PlanReviewPart,
	options: { fontSize: number; contentWidth: number },
) {
	const bodyWidth = Math.max(MIN_TEXT_WIDTH, options.contentWidth - 24);
	const planHeight = measureTextHeight(
		part.plan?.trim() || "No plan content was attached to this request.",
		{
			fontSize: Math.max(options.fontSize - 2, 12),
			lineHeight: 20,
			maxWidth: bodyWidth,
			whiteSpace: "pre-wrap",
		},
	);
	const promptsHeight = (part.allowedPrompts ?? []).reduce((sum, entry) => {
		return (
			sum +
			measureTextHeight(entry.prompt, {
				fontSize: Math.max(options.fontSize - 2, 12),
				lineHeight: 18,
				maxWidth: bodyWidth - 16,
				whiteSpace: "normal",
			}) +
			34
		);
	}, 0);
	const filePathHeight = part.planFilePath
		? measureTextHeight(part.planFilePath, {
				fontSize: Math.max(options.fontSize - 2, 12),
				lineHeight: 18,
				maxWidth: bodyWidth,
				whiteSpace: "normal",
			}) + 6
		: 0;

	return 86 + filePathHeight + planHeight + promptsHeight + 36;
}

function estimateAssistantTextHeight(
	text: string,
	options: { fontSize: number; contentWidth: number },
) {
	if (!looksLikeStructuredMarkdown(text)) {
		return measureTextHeight(text, {
			fontSize: options.fontSize,
			lineHeight: ASSISTANT_LINE_HEIGHT,
			maxWidth: options.contentWidth,
			whiteSpace: "normal",
		});
	}

	const lines = text.split("\n");
	let totalHeight = 0;
	let paragraphLines: string[] = [];

	const appendBlock = (height: number) => {
		if (height <= 0) return;
		totalHeight += height;
		if (totalHeight > 0) {
			totalHeight += MARKDOWN_BLOCK_GAP;
		}
	};

	const flushParagraph = () => {
		const paragraph = paragraphLines.join(" ").trim();
		paragraphLines = [];
		if (paragraph.length === 0) {
			return;
		}
		appendBlock(
			measureTextHeight(paragraph, {
				fontSize: options.fontSize,
				lineHeight: ASSISTANT_LINE_HEIGHT,
				maxWidth: options.contentWidth,
				whiteSpace: "normal",
			}),
		);
	};

	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index] ?? "";
		const trimmed = rawLine.trim();

		if (trimmed.length === 0) {
			flushParagraph();
			continue;
		}

		if (trimmed.startsWith("```")) {
			flushParagraph();
			let codeLineCount = 0;
			index += 1;
			while (
				index < lines.length &&
				!(lines[index] ?? "").trim().startsWith("```")
			) {
				codeLineCount += 1;
				index += 1;
			}
			appendBlock(
				MARKDOWN_CODE_BLOCK_PADDING +
					Math.max(1, codeLineCount) * MARKDOWN_CODE_LINE_HEIGHT,
			);
			continue;
		}

		const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (headingMatch) {
			flushParagraph();
			const headingLevel = headingMatch[1].length;
			const headingLineHeight =
				headingLevel <= 2 ? 34 : headingLevel === 3 ? 30 : 26;
			appendBlock(
				measureTextHeight(headingMatch[2], {
					fontSize: options.fontSize,
					lineHeight: headingLineHeight,
					maxWidth: options.contentWidth,
					whiteSpace: "normal",
				}) +
					MARKDOWN_HEADING_MARGIN_TOP +
					MARKDOWN_HEADING_MARGIN_BOTTOM,
			);
			continue;
		}

		if (
			isMarkdownTableLine(trimmed) &&
			index + 1 < lines.length &&
			isMarkdownTableSeparator((lines[index + 1] ?? "").trim())
		) {
			flushParagraph();
			let rowCount = 1;
			index += 2;
			while (index < lines.length) {
				const rowLine = (lines[index] ?? "").trim();
				if (!isMarkdownTableLine(rowLine) || rowLine.length === 0) {
					index -= 1;
					break;
				}
				rowCount += 1;
				index += 1;
			}
			if (index >= lines.length) {
				index = lines.length - 1;
			}
			appendBlock(
				MARKDOWN_TABLE_TOOLBAR_HEIGHT + rowCount * MARKDOWN_TABLE_ROW_HEIGHT,
			);
			continue;
		}

		if (isMarkdownListLine(trimmed)) {
			flushParagraph();
			const listLines = [trimmed];
			while (index + 1 < lines.length) {
				const nextLine = lines[index + 1] ?? "";
				const nextTrimmed = nextLine.trim();
				if (
					nextTrimmed.length === 0 ||
					(!isMarkdownListLine(nextTrimmed) && !/^\s{2,}\S/.test(nextLine))
				) {
					break;
				}
				listLines.push(nextLine);
				index += 1;
			}
			appendBlock(
				measureTextHeight(listLines.join("\n"), {
					fontSize: options.fontSize,
					lineHeight: ASSISTANT_LINE_HEIGHT,
					maxWidth: options.contentWidth,
					whiteSpace: "pre-wrap",
				}),
			);
			continue;
		}

		if (trimmed.startsWith(">")) {
			flushParagraph();
			const quoteLines = [trimmed.replace(/^>\s?/, "")];
			while (
				index + 1 < lines.length &&
				(lines[index + 1] ?? "").trim().startsWith(">")
			) {
				quoteLines.push((lines[index + 1] ?? "").trim().replace(/^>\s?/, ""));
				index += 1;
			}
			appendBlock(
				measureTextHeight(quoteLines.join("\n"), {
					fontSize: options.fontSize,
					lineHeight: ASSISTANT_LINE_HEIGHT,
					maxWidth: options.contentWidth,
					whiteSpace: "pre-wrap",
				}) + MARKDOWN_QUOTE_PADDING,
			);
			continue;
		}

		paragraphLines.push(trimmed);
	}

	flushParagraph();
	return Math.max(ASSISTANT_LINE_HEIGHT, totalHeight - MARKDOWN_BLOCK_GAP);
}

function estimateUserMessageHeight(
	message: ThreadMessageLike,
	options: { fontSize: number; contentWidth: number },
) {
	const parts = message.content as MessagePart[];
	const text = parts
		.filter(
			(part): part is Extract<MessagePart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.join("\n");
	// A pasted-text tag renders as a one-line chip (see PastedTextBadge), not
	// its content — count it as a single line. This is what keeps a giant
	// paste out of both the pretext layout and the mounted DOM: its text
	// never reaches measureTextHeight.
	const pastedChipHeight =
		parts.filter((part) => part.type === "pasted-text").length *
		USER_LINE_HEIGHT;
	const bubbleWidth = Math.max(
		MIN_TEXT_WIDTH,
		Math.floor(options.contentWidth * USER_BUBBLE_WIDTH_RATIO) -
			USER_BUBBLE_HORIZONTAL_PADDING,
	);
	const textHeight =
		text.trim().length > 0
			? measureTextHeight(text, {
					fontSize: options.fontSize,
					lineHeight: USER_LINE_HEIGHT,
					maxWidth: bubbleWidth,
					whiteSpace: "pre-wrap",
				})
			: 0;

	let contentHeight = Math.max(USER_LINE_HEIGHT, textHeight + pastedChipHeight);
	// Same semantics as the renderer's truncation probe: content taller than
	// the visual-line cap renders clamped plus the Show-more control row.
	// `contentHeight` already IS the visual-line height (pretext wraps the
	// text exactly like the bubble does), so no line counting here either.
	const clampCapHeight = USER_MESSAGE_CLAMP_LINES * USER_LINE_HEIGHT;
	if (contentHeight > clampCapHeight) {
		contentHeight = clampCapHeight + USER_CLAMP_CONTROL_HEIGHT;
	}

	return (
		contentHeight + USER_BUBBLE_VERTICAL_PADDING + ROW_SHELL_BOTTOM_PADDING
	);
}

function estimateSystemMessageHeight(
	message: ThreadMessageLike,
	options: { fontSize: number; contentWidth: number },
) {
	const parts = message.content as MessagePart[];
	const text = parts
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "system-notice") {
				return part.body ? `${part.label} — ${part.body}` : part.label;
			}
			if (part.type === "prompt-suggestion") return part.text;
			return "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
	const textHeight = measureTextHeight(text, {
		fontSize: Math.max(11, options.fontSize - 2),
		lineHeight: SYSTEM_LINE_HEIGHT,
		maxWidth: options.contentWidth,
		whiteSpace: "pre-wrap",
	});

	return textHeight + 8 + ROW_SHELL_BOTTOM_PADDING;
}

function estimateToolCallHeight(part: ToolCallPart) {
	const hasOutput = part.result !== undefined && part.result !== null;
	return hasOutput ? TOOL_SUMMARY_HEIGHT : 22;
}

function estimateCollapsedGroupHeight(group: CollapsedGroupPart) {
	if (group.tools.length === 0) {
		return group.active ? COLLAPSED_GROUP_HEIGHT + 4 : COLLAPSED_GROUP_HEIGHT;
	}

	const childHeights = group.tools.map((tool) => estimateToolCallHeight(tool));
	const childrenHeight = childHeights.reduce((sum, height) => sum + height, 0);
	const childrenGapHeight = Math.max(0, group.tools.length - 1) * 2;
	const expandedChildrenHeight = 4 + childrenHeight + childrenGapHeight;
	const trailingToolHeight =
		childHeights[childHeights.length - 1] ?? TOOL_SUMMARY_HEIGHT;
	const activeBuffer = group.active ? trailingToolHeight + 8 : 0;

	return COLLAPSED_GROUP_HEIGHT + expandedChildrenHeight + activeBuffer;
}

function looksLikeStructuredMarkdown(text: string) {
	return (
		text.includes("```") ||
		/\n#{1,6}\s/.test(text) ||
		/\n\s*[-*+]\s+/.test(text) ||
		/\n\s*\d+\.\s+/.test(text) ||
		/\n>/.test(text) ||
		/\n\n/.test(text) ||
		/\|/.test(text)
	);
}

function isMarkdownListLine(line: string) {
	return /^([-*+]|\d+\.)\s+/.test(line);
}

function isMarkdownTableLine(line: string) {
	return line.includes("|");
}

function isMarkdownTableSeparator(line: string) {
	return /^\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/.test(line);
}

/**
 * pretext renders `\t` at its default `tab-size: 8`, but the live `pre-wrap`
 * surfaces (user bubble `<p class="whitespace-pre-wrap break-words">`, reasoning
 * body, plan review) render at `tab-size: 4`. pretext 0.0.x exposes no option to
 * change the tab stop, so for tab-indented pasted code pretext counts every tab
 * as double its on-screen width and over-predicts how many lines the text wraps
 * to. Expanding each tab to the spaces that reach the next 4-column tab stop —
 * column-aware, per line — makes pretext see the exact glyphs the browser lays
 * out, so the estimate matches the live tab-size-4 DOM. Width math (`maxWidth`)
 * is untouched. Only the `pre-wrap` path calls this; `normal` collapses
 * whitespace anyway.
 */
function expandTabsToFourColumnStops(text: string): string {
	if (!text.includes("\t")) {
		return text;
	}
	const lines = text.split("\n");
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? "";
		if (!line.includes("\t")) {
			continue;
		}
		let expanded = "";
		let column = 0;
		for (const char of line) {
			if (char === "\t") {
				const advance = 4 - (column % 4);
				expanded += " ".repeat(advance);
				column += advance;
			} else {
				expanded += char;
				column += 1;
			}
		}
		lines[lineIndex] = expanded;
	}
	return lines.join("\n");
}

// Exported for the accuracy tests: long user messages now estimate to a
// collapsed constant, so the pre-wrap measurement gates (break-word counting,
// tab-size-4 normalization) lock this function directly.
export function measureTextHeight(
	text: string,
	options: {
		fontSize: number;
		lineHeight: number;
		maxWidth: number;
		whiteSpace: "normal" | "pre-wrap";
	},
) {
	const normalizedText =
		options.whiteSpace === "pre-wrap"
			? expandTabsToFourColumnStops(text)
			: text.replace(/\s+/g, " ").trim();

	if (normalizedText.length === 0) {
		return options.lineHeight;
	}

	try {
		const font = `${options.fontSize}px "Geist Variable"`;
		const prepared = getPreparedText(normalizedText, font, options.whiteSpace);
		return Math.max(
			options.lineHeight,
			Math.ceil(
				layout(
					prepared,
					Math.max(MIN_TEXT_WIDTH, Math.floor(options.maxWidth)),
					options.lineHeight,
				).height,
			),
		);
	} catch {
		return fallbackTextHeight(normalizedText, options);
	}
}

function getPreparedText(
	text: string,
	font: string,
	whiteSpace: "normal" | "pre-wrap",
) {
	const cacheKey = `${font}\u0000${whiteSpace}\u0000${text}`;
	const cached = preparedTextCache.get(cacheKey);
	if (cached) {
		// LRU bump: re-insert moves the entry to the most-recent position.
		preparedTextCache.delete(cacheKey);
		preparedTextCache.set(cacheKey, cached);
		return cached;
	}

	const prepared = prepare(text, font, { whiteSpace });
	preparedTextCache.set(cacheKey, prepared);
	if (preparedTextCache.size > PREPARED_TEXT_CACHE_LIMIT) {
		// Trim oldest entries (insertion order). Drop ~10% at once so the
		// trim cost amortizes nicely instead of running on every insert.
		const dropCount = Math.ceil(PREPARED_TEXT_CACHE_LIMIT * 0.1);
		const iterator = preparedTextCache.keys();
		for (let i = 0; i < dropCount; i += 1) {
			const next = iterator.next();
			if (next.done) break;
			preparedTextCache.delete(next.value);
		}
	}
	return prepared;
}

function fallbackTextHeight(
	text: string,
	options: {
		fontSize: number;
		lineHeight: number;
		maxWidth: number;
		whiteSpace: "normal" | "pre-wrap";
	},
) {
	const rows = splitForFallback(text, options.whiteSpace);
	const avgCharWidth = Math.max(6, options.fontSize * 0.58);
	const charsPerLine = Math.max(
		1,
		Math.floor(Math.max(MIN_TEXT_WIDTH, options.maxWidth) / avgCharWidth),
	);
	let lineCount = 0;

	for (const row of rows) {
		lineCount += Math.max(1, Math.ceil(row.length / charsPerLine));
	}

	return Math.max(options.lineHeight, lineCount * options.lineHeight);
}

function splitForFallback(
	text: string,
	whiteSpace: "normal" | "pre-wrap",
): string[] {
	if (whiteSpace === "pre-wrap") {
		return text.split("\n");
	}

	return [text.replace(/\s+/g, " ").trim()];
}
