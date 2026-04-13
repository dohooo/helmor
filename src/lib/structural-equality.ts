/**
 * Structural equality helpers for `ThreadMessageLike` and its parts.
 *
 * Used by:
 * - `shareMessages` in `session-thread-cache.ts` — decides whether to
 *   reuse a previous message reference when the streaming pipeline
 *   writes a new turn into the React Query cache, keeping the
 *   `MemoConversationMessage` `prev.message === next.message` bail-out
 *   alive.
 * - `AssistantToolCall` and `AgentChildrenBlock` memo comparators in
 *   `workspace-panel.tsx` — decide whether a re-render can be skipped
 *   when the parent message gets a new reference for an unrelated reason
 *   (e.g. a sibling subagent's children grew).
 *
 * Both call sites need the SAME definition of "equal" or the bail-outs
 * will drift and we'll either render stale data (false positives) or
 * waste CPU on no-op re-renders (false negatives that cascade through
 * the subagent tree).
 *
 * Lives in `src/lib/` so both `workspace-panel-container.tsx` (which
 * imports `WorkspacePanel`) and `workspace-panel.tsx` can reach it
 * without forming a circular dependency.
 */

import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	FileMentionPart,
	ImagePart,
	MessagePart,
	PlanReviewPart,
	PromptSuggestionPart,
	SystemNoticePart,
	ThreadMessageLike,
	TodoListPart,
	ToolCallPart,
} from "./api";

export function partsStructurallyEqual(
	a: ExtendedMessagePart[],
	b: ExtendedMessagePart[],
): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (!partStructurallyEqual(a[i]!, b[i]!)) return false;
	}
	return true;
}

export function partStructurallyEqual(
	a: ExtendedMessagePart,
	b: ExtendedMessagePart,
): boolean {
	if (a === b) return true;
	if (a.type !== b.type) return false;
	switch (a.type) {
		case "text": {
			const tb = b as Extract<MessagePart, { type: "text" }>;
			return a.text === tb.text;
		}
		case "reasoning": {
			const rb = b as Extract<MessagePart, { type: "reasoning" }>;
			return a.text === rb.text && a.streaming === rb.streaming;
		}
		case "tool-call": {
			const tb = b as ToolCallPart;
			if (a.toolCallId !== tb.toolCallId) return false;
			if (a.toolName !== tb.toolName) return false;
			if (a.streamingStatus !== tb.streamingStatus) return false;
			if (a.argsText !== tb.argsText) return false;
			// `result` is a JSON value or a plain string. Compare by value
			// for strings (cheap, semantically correct) and fall back to
			// reference equality for non-string payloads. The reference
			// fallback matches the existing concern about backend wrapper
			// allocations producing fresh references for unchanged data.
			if (typeof a.result === "string" || typeof tb.result === "string") {
				if (a.result !== tb.result) return false;
			} else if (a.result !== tb.result) {
				return false;
			}
			// `children` is the typed sub-agent payload that the Rust
			// grouping pass appends to as a Task/Agent subagent streams.
			// MUST recurse — skipping this check lets the structural-
			// sharing helper reuse the prior tool-call reference while
			// the pipeline keeps appending, so the rendered children
			// drift from actual state.
			return childrenStructurallyEqual(a.children, tb.children);
		}
		case "collapsed-group": {
			const gb = b as CollapsedGroupPart;
			if (a.active !== gb.active) return false;
			if (a.category !== gb.category) return false;
			if (a.summary !== gb.summary) return false;
			if (a.tools.length !== gb.tools.length) return false;
			for (let i = 0; i < a.tools.length; i += 1) {
				if (!partStructurallyEqual(a.tools[i]!, gb.tools[i]!)) return false;
			}
			return true;
		}
		case "system-notice": {
			const sb = b as SystemNoticePart;
			return (
				a.severity === sb.severity && a.label === sb.label && a.body === sb.body
			);
		}
		case "todo-list": {
			const tb = b as TodoListPart;
			if (a.items.length !== tb.items.length) return false;
			for (let i = 0; i < a.items.length; i += 1) {
				if (
					a.items[i]!.text !== tb.items[i]!.text ||
					a.items[i]!.status !== tb.items[i]!.status
				)
					return false;
			}
			return true;
		}
		case "image": {
			const ib = b as ImagePart;
			if (a.mediaType !== ib.mediaType) return false;
			if (a.source.kind !== ib.source.kind) return false;
			if (a.source.kind === "base64") {
				return a.source.data === (ib.source as typeof a.source).data;
			}
			return (
				(a.source as { url: string }).url === (ib.source as { url: string }).url
			);
		}
		case "prompt-suggestion": {
			const pb = b as PromptSuggestionPart;
			return a.text === pb.text;
		}
		case "file-mention": {
			const fb = b as FileMentionPart;
			return a.path === fb.path;
		}
		case "plan-review": {
			const pb = b as PlanReviewPart;
			if (a.toolUseId !== pb.toolUseId) return false;
			if (a.toolName !== pb.toolName) return false;
			if (a.plan !== pb.plan) return false;
			if (a.planFilePath !== pb.planFilePath) return false;
			const aPrompts = a.allowedPrompts ?? [];
			const bPrompts = pb.allowedPrompts ?? [];
			if (aPrompts.length !== bPrompts.length) return false;
			for (let i = 0; i < aPrompts.length; i += 1) {
				if (aPrompts[i]!.tool !== bPrompts[i]!.tool) return false;
				if (aPrompts[i]!.prompt !== bPrompts[i]!.prompt) return false;
			}
			return true;
		}
		default: {
			const _exhaustive: never = a;
			return _exhaustive === b;
		}
	}
}

/**
 * Compare two optional `children` arrays from a Task/Agent tool-call.
 *
 * Exported separately so the `AssistantToolCall` and `AgentChildrenBlock`
 * memo comparators can do the same content-aware check the
 * `partStructurallyEqual` recursion uses internally.
 */
export function childrenStructurallyEqual(
	a: ExtendedMessagePart[] | undefined,
	b: ExtendedMessagePart[] | undefined,
): boolean {
	if (a === b) return true;
	const aLen = a?.length ?? 0;
	const bLen = b?.length ?? 0;
	if (aLen !== bLen) return false;
	if (aLen === 0) return true;
	for (let i = 0; i < aLen; i += 1) {
		if (!partStructurallyEqual(a![i]!, b![i]!)) return false;
	}
	return true;
}

/** Equality predicate that powers `shareMessages`. Pinning its
 *  behavior in unit tests prevents "looks the same, but isn't"
 *  discrepancies between the sharing helper and React's memo
 *  bail-out from stalling the rendered thread on a stale snapshot. */
export function messagesStructurallyEqual(
	a: ThreadMessageLike,
	b: ThreadMessageLike,
): boolean {
	if (a === b) return true;
	if (a.id !== b.id) return false;
	if (a.role !== b.role) return false;
	if (a.streaming !== b.streaming) return false;
	if (a.createdAt !== b.createdAt) return false;
	if (a.status !== b.status) {
		if (!a.status || !b.status) return false;
		if (a.status.type !== b.status.type) return false;
		if (a.status.reason !== b.status.reason) return false;
	}
	return partsStructurallyEqual(a.content, b.content);
}
