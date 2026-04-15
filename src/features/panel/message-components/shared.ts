import type {
	CollapsedGroupPart,
	FileMentionPart,
	ImagePart,
	MessagePart,
	PlanReviewPart,
	PromptSuggestionPart,
	SystemNoticePart,
	ThreadMessageLike,
	TodoListPart,
} from "@/lib/api";

export type RenderedMessage = ThreadMessageLike;
export type StreamdownMode = "static" | "streaming";

export type FileChangeInfo = {
	name: string;
	diffAdd?: number;
	diffDel?: number;
};

export type ToolInfo = {
	action: string;
	file?: string;
	detail?: string;
	command?: string;
	fullCommand?: string;
	icon: React.ReactNode;
	diffAdd?: number;
	diffDel?: number;
	body?: string;
	files?: FileChangeInfo[];
};

// --- type guards ---

export function isTextPart(
	part: unknown,
): part is Extract<MessagePart, { type: "text" }> {
	return isObj(part) && part.type === "text" && typeof part.text === "string";
}

export function isReasoningPart(
	part: unknown,
): part is Extract<MessagePart, { type: "reasoning" }> {
	return (
		isObj(part) && part.type === "reasoning" && typeof part.text === "string"
	);
}

export function isToolCallPart(
	part: unknown,
): part is Extract<MessagePart, { type: "tool-call" }> {
	return (
		isObj(part) &&
		part.type === "tool-call" &&
		typeof part.toolName === "string" &&
		isObj(part.args)
	);
}

export function isCollapsedGroupPart(
	part: unknown,
): part is CollapsedGroupPart {
	return (
		isObj(part) && part.type === "collapsed-group" && Array.isArray(part.tools)
	);
}

export function isSystemNoticePart(part: unknown): part is SystemNoticePart {
	return (
		isObj(part) &&
		part.type === "system-notice" &&
		typeof part.label === "string" &&
		(part.severity === "info" ||
			part.severity === "warning" ||
			part.severity === "error")
	);
}

export function isTodoListPart(part: unknown): part is TodoListPart {
	return isObj(part) && part.type === "todo-list" && Array.isArray(part.items);
}

export function isImagePart(part: unknown): part is ImagePart {
	return isObj(part) && part.type === "image" && isObj(part.source);
}

export function isPromptSuggestionPart(
	part: unknown,
): part is PromptSuggestionPart {
	return (
		isObj(part) &&
		part.type === "prompt-suggestion" &&
		typeof part.text === "string"
	);
}

export function isFileMentionPart(part: unknown): part is FileMentionPart {
	return (
		isObj(part) && part.type === "file-mention" && typeof part.path === "string"
	);
}

export function isPlanReviewPart(part: unknown): part is PlanReviewPart {
	return (
		isObj(part) &&
		part.type === "plan-review" &&
		typeof part.toolUseId === "string" &&
		typeof part.toolName === "string"
	);
}

// --- tiny utils ---

export function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

export function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function basename(path: string): string {
	return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLiveStreamingStatus(status: string | undefined): boolean {
	return (
		status === "pending" || status === "streaming_input" || status === "running"
	);
}
