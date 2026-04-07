import { layout, type PreparedText, prepare } from "@chenglou/pretext";
import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	MessagePart,
	ThreadMessageLike,
	ToolCallPart,
} from "./api";

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
const COLLAPSED_GROUP_HEIGHT = 24;
const USER_BUBBLE_VERTICAL_PADDING = 16;
const USER_BUBBLE_HORIZONTAL_PADDING = 24;
const USER_BUBBLE_WIDTH_RATIO = 0.75;
const MIN_TEXT_WIDTH = 64;

const preparedTextCache = new Map<string, PreparedText>();

export function estimateThreadRowHeights(
	messages: ThreadMessageLike[],
	options: EstimateOptions,
): number[] {
	const contentWidth = Math.max(MIN_TEXT_WIDTH, options.paneWidth - 40);

	return messages.map((message) =>
		estimateMessageRowHeight(message, {
			fontSize: options.fontSize,
			contentWidth,
		}),
	);
}

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
			return measureTextHeight(part.text, {
				fontSize: options.fontSize,
				lineHeight: ASSISTANT_LINE_HEIGHT,
				maxWidth: options.contentWidth,
				whiteSpace: "normal",
			});
		case "reasoning":
			return REASONING_SUMMARY_HEIGHT;
		case "tool-call":
			return estimateToolCallHeight(part);
		case "collapsed-group":
			return estimateCollapsedGroupHeight(part);
		default:
			return TOOL_SUMMARY_HEIGHT;
	}
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
	const bubbleWidth = Math.max(
		MIN_TEXT_WIDTH,
		Math.floor(options.contentWidth * USER_BUBBLE_WIDTH_RATIO) -
			USER_BUBBLE_HORIZONTAL_PADDING,
	);
	const textHeight = measureTextHeight(text, {
		fontSize: options.fontSize,
		lineHeight: USER_LINE_HEIGHT,
		maxWidth: bubbleWidth,
		whiteSpace: "pre-wrap",
	});

	return textHeight + USER_BUBBLE_VERTICAL_PADDING + ROW_SHELL_BOTTOM_PADDING;
}

function estimateSystemMessageHeight(
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
	return group.active ? COLLAPSED_GROUP_HEIGHT + 4 : COLLAPSED_GROUP_HEIGHT;
}

function measureTextHeight(
	text: string,
	options: {
		fontSize: number;
		lineHeight: number;
		maxWidth: number;
		whiteSpace: "normal" | "pre-wrap";
	},
) {
	const normalizedText =
		options.whiteSpace === "pre-wrap" ? text : text.replace(/\s+/g, " ").trim();

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
		return cached;
	}

	const prepared = prepare(text, font, { whiteSpace });
	preparedTextCache.set(cacheKey, prepared);
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
