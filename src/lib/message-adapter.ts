/**
 * Adapter: SessionMessageRecord[] → UI thread messages
 */
import type { SessionMessageRecord } from "./api";
import {
	type CollapsedGroupPart,
	collapseToolCallsInParts,
	type ExtendedMessagePart,
} from "./collapse-read-search";

export type TextPart = { type: "text"; text: string };
export type ReasoningPart = { type: "reasoning"; text: string };
export type ToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	argsText: string;
	result?: unknown;
	/** Set during streaming to indicate tool execution progress */
	streamingStatus?:
		| "pending"
		| "streaming_input"
		| "running"
		| "done"
		| "error";
};
export type MessagePart = TextPart | ReasoningPart | ToolCallPart;
export type { CollapsedGroupPart, ExtendedMessagePart };
export type ThreadMessageLike = {
	role: "assistant" | "system" | "user";
	id?: string;
	createdAt?: Date;
	content: (MessagePart | CollapsedGroupPart)[];
	status?: {
		type: string;
		reason?: string;
	};
	/** True when this message is still being streamed from an agent. */
	streaming?: boolean;
};

type ProjectionCache = {
	rawSignatures: string[];
	renderedSignatures: string[];
	renderedMessages: ThreadMessageLike[];
};

const projectionCacheBySession = new Map<string, ProjectionCache>();

export function convertMessages(
	messages: SessionMessageRecord[],
	sessionId = "__default__",
	options?: { collapse?: boolean },
): ThreadMessageLike[] {
	const rawSignatures = messages.map(getRawMessageSignature);
	const cached = projectionCacheBySession.get(sessionId);

	if (cached && arraysEqual(cached.rawSignatures, rawSignatures)) {
		return cached.renderedMessages;
	}

	let nextMessages = groupChildMessages(convertMessagesFlat(messages));

	// Apply collapse pass: consecutive search/read tool calls → summary groups
	if (options?.collapse) {
		nextMessages = applyCollapsePass(nextMessages);
	}

	const renderedSignatures = nextMessages.map(getRenderedMessageSignature);
	const renderedMessages = nextMessages.map((message, index) => {
		if (
			cached?.renderedMessages[index] &&
			cached.renderedMessages[index]?.id === message.id &&
			cached.renderedSignatures[index] === renderedSignatures[index]
		) {
			return cached.renderedMessages[index];
		}

		return message;
	});

	projectionCacheBySession.set(sessionId, {
		rawSignatures,
		renderedSignatures,
		renderedMessages,
	});

	return renderedMessages;
}

function convertMessagesFlat(
	messages: SessionMessageRecord[],
): ThreadMessageLike[] {
	const result: ThreadMessageLike[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const parsed = msg.contentIsJson
			? (msg.parsedContent as Record<string, unknown> | undefined)
			: undefined;
		const msgType = parsed?.type as string | undefined;

		// system — skip noise subtypes
		if (msgType === "system") {
			const sub = parsed!.subtype as string | undefined;
			if (
				sub === "init" ||
				sub === "task_progress" ||
				sub === "task_started" ||
				sub === "task_completed" ||
				sub === "task_notification"
			)
				continue;
			result.push(makeSystem(msg, buildSystemLabel(parsed!)));
			continue;
		}

		// result (session summary)
		if (msgType === "result") {
			result.push(makeSystem(msg, buildResultLabel(parsed!)));
			continue;
		}

		// error
		if (msgType === "error" || msg.role === "error") {
			result.push(makeSystem(msg, buildErrorLabel(msg, parsed)));
			continue;
		}

		// assistant (by JSON type or by role for plain-text live messages)
		if (msgType === "assistant" || (!parsed && msg.role === "assistant")) {
			const parts = parseAssistantParts(parsed);
			const isChild =
				parsed != null && typeof parsed.parent_tool_use_id === "string";

			// Look ahead: merge following user/tool_result messages
			while (i + 1 < messages.length) {
				const next = messages[i + 1];
				const np = next.contentIsJson
					? (next.parsedContent as Record<string, unknown> | undefined)
					: undefined;
				const nextType = np?.type as string | undefined;
				if (nextType !== "user") break;
				const merged = mergeToolResults(np, parts);
				if (!merged) break;
				i++;
			}

			if (parts.length === 0) {
				const fb = extractFallback(msg);
				if (fb) parts.push({ type: "text", text: fb });
			}

			result.push({
				role: "assistant",
				id: isChild ? `child:${msg.id}` : msg.id,
				createdAt: new Date(msg.createdAt),
				content: parts,
				status: { type: "complete", reason: "stop" },
				streaming: parsed?.__streaming === true || undefined,
			});
			continue;
		}

		// user — tool_result messages: merge into previous assistant or skip entirely
		if (msgType === "user") {
			const prev = result[result.length - 1];
			if (prev?.role === "assistant" && parsed) {
				mergeToolResults(parsed, prev.content as MessagePart[]);
			}
			// Never render user tool_result messages as standalone — they are always
			// paired with a tool-call and should be merged or silently skipped.
			// Only show real user text messages (non-JSON or with actual text content).
			if (parsed) continue;
			result.push(convertUserMessage(msg, parsed));
			continue;
		}

		// Codex: item.completed with agent_message — render as assistant text
		if (msgType === "item.completed") {
			const item = parsed?.item as Record<string, unknown> | undefined;
			if (item?.type === "agent_message" && typeof item.text === "string") {
				result.push({
					role: "assistant",
					id: msg.id,
					createdAt: new Date(msg.createdAt),
					content: [{ type: "text", text: item.text as string }],
					status: { type: "complete", reason: "stop" },
				});
			}
			continue;
		}

		// Codex: turn.completed — render as session summary
		if (msgType === "turn.completed") {
			result.push(makeSystem(msg, buildResultLabel(parsed!)));
			continue;
		}

		// user by role (plain text, non-JSON)
		if (msg.role === "user" && !parsed) {
			result.push(convertUserMessage(msg, undefined));
			continue;
		}

		// unknown
		result.push(makeSystem(msg, msgType ? `${msgType} event` : "Event"));
	}

	return result;
}

// ---------------------------------------------------------------------------
// Assistant parsing
// ---------------------------------------------------------------------------

function parseAssistantParts(
	parsed: Record<string, unknown> | undefined,
): MessagePart[] {
	if (!parsed) return [];
	const msg = isObj(parsed.message) ? parsed.message : null;
	const blocks = Array.isArray(msg?.content) ? msg!.content : [];
	const parts: MessagePart[] = [];

	for (const b of blocks) {
		if (!isObj(b)) continue;
		if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push({ type: "reasoning", text: b.thinking });
		} else if (b.type === "redacted_thinking") {
			parts.push({ type: "reasoning", text: "[Thinking redacted]" });
		} else if (b.type === "text" && typeof b.text === "string") {
			parts.push({ type: "text", text: b.text });
		} else if (b.type === "tool_use" || b.type === "server_tool_use") {
			const args = isObj(b.input) ? (b.input as Record<string, unknown>) : {};
			const streamStatus = b.__streaming_status as
				| ToolCallPart["streamingStatus"]
				| undefined;
			const rawJsonText =
				typeof b.__input_json_text === "string"
					? (b.__input_json_text as string)
					: null;
			parts.push({
				type: "tool-call",
				toolCallId: String(b.id ?? `tc-${parts.length}`),
				toolName: String(b.name ?? "unknown"),
				args,
				argsText: rawJsonText || JSON.stringify(args),
				...(streamStatus ? { streamingStatus: streamStatus } : {}),
			});
		}
	}
	return parts;
}

// ---------------------------------------------------------------------------
// Merge tool_result user messages into preceding tool-call parts
// ---------------------------------------------------------------------------

function mergeToolResults(
	parsed: Record<string, unknown> | undefined,
	targetParts: MessagePart[],
): boolean {
	if (!parsed) return false;
	const msg = isObj(parsed.message) ? parsed.message : null;
	const blocks = Array.isArray(msg?.content) ? msg!.content : [];
	if (blocks.length === 0) return false;

	let allToolResult = true;
	const results: { toolUseId: string; content: string }[] = [];

	for (const b of blocks) {
		if (!isObj(b)) continue;
		if (b.type === "tool_result") {
			const content =
				typeof b.content === "string"
					? b.content
					: Array.isArray(b.content)
						? (b.content as unknown[])
								.filter(
									(x): x is Record<string, unknown> =>
										isObj(x) && typeof x.text === "string",
								)
								.map((x) => x.text as string)
								.join("\n")
						: "";
			results.push({
				toolUseId: String(b.tool_use_id ?? ""),
				content,
			});
		} else if (
			b.type === "text" &&
			typeof b.text === "string" &&
			b.text.trim()
		) {
			allToolResult = false;
		} else if (b.type !== "image" && b.type !== "file") {
			allToolResult = false;
		}
	}

	if (!allToolResult || results.length === 0) return false;

	// Attach results to matching tool-call parts
	for (const r of results) {
		const tc = targetParts.find(
			(p): p is ToolCallPart =>
				p.type === "tool-call" && p.toolCallId === r.toolUseId,
		);
		if (tc) {
			tc.result = r.content;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

function convertUserMessage(
	msg: SessionMessageRecord,
	parsed: Record<string, unknown> | undefined,
): ThreadMessageLike {
	const parts: TextPart[] = [];
	if (parsed) {
		const message = isObj(parsed.message) ? parsed.message : null;
		const blocks = Array.isArray(message?.content) ? message!.content : [];
		for (const b of blocks) {
			if (isObj(b) && b.type === "text" && typeof b.text === "string") {
				parts.push({ type: "text", text: b.text });
			}
		}
	}
	if (parts.length === 0) {
		parts.push({ type: "text", text: extractFallback(msg) });
	}
	return {
		role: "user",
		id: msg.id,
		createdAt: new Date(msg.createdAt),
		content: parts,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSystem(
	msg: SessionMessageRecord,
	text: string,
): ThreadMessageLike {
	return {
		role: "system",
		id: msg.id,
		createdAt: new Date(msg.createdAt),
		content: [{ type: "text", text }],
	};
}

function buildSystemLabel(p: Record<string, unknown>): string {
	const sub = p.subtype as string | undefined;
	const model = p.model as string | undefined;
	if (sub === "init")
		return model ? `Session initialized — ${model}` : "Session initialized";
	return sub ? `System: ${sub}` : "System";
}

function buildResultLabel(p: Record<string, unknown>): string {
	const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd : null;
	const durationMs = typeof p.duration_ms === "number" ? p.duration_ms : null;
	const usage = isObj(p.usage) ? p.usage : null;
	const inputTokens =
		typeof usage?.input_tokens === "number"
			? usage.input_tokens
			: typeof p.input_tokens === "number"
				? p.input_tokens
				: null;
	const outputTokens =
		typeof usage?.output_tokens === "number"
			? usage.output_tokens
			: typeof p.output_tokens === "number"
				? p.output_tokens
				: null;
	const bits: string[] = [];
	if (durationMs !== null) {
		const totalSecs = durationMs / 1000;
		if (totalSecs >= 60) {
			const mins = Math.floor(totalSecs / 60);
			const secs = Math.round(totalSecs % 60);
			bits.push(secs > 0 ? `${mins}m ${secs}s` : `${mins}m`);
		} else {
			bits.push(`${totalSecs.toFixed(1)}s`);
		}
	}
	if (inputTokens !== null) bits.push(`in ${formatCount(inputTokens)}`);
	if (outputTokens !== null) bits.push(`out ${formatCount(outputTokens)}`);
	if (cost !== null) bits.push(`$${cost.toFixed(4)}`);
	return bits.join(" • ") || "Done";
}

function buildErrorLabel(
	msg: SessionMessageRecord,
	parsed: Record<string, unknown> | undefined,
): string {
	// Try to extract a clean error message from structured content
	if (parsed) {
		const content = parsed.content as string | undefined;
		if (typeof content === "string" && content.trim())
			return `Error: ${content}`;
		const message = parsed.message as string | undefined;
		if (typeof message === "string" && message.trim())
			return `Error: ${message}`;
	}
	// If the raw content is JSON, try parsing it
	if (msg.contentIsJson && msg.parsedContent) {
		const p = msg.parsedContent as Record<string, unknown>;
		if (typeof p.content === "string") return `Error: ${p.content}`;
		if (typeof p.message === "string") return `Error: ${p.message}`;
	}
	const fb = extractFallback(msg);
	// Don't show raw JSON as error text
	if (fb.startsWith("{")) {
		try {
			const obj = JSON.parse(fb) as Record<string, unknown>;
			if (typeof obj.content === "string") return `Error: ${obj.content}`;
			if (typeof obj.message === "string") return `Error: ${obj.message}`;
		} catch {
			/* ignore */
		}
	}
	return `Error: ${fb}`;
}

function extractFallback(msg: SessionMessageRecord): string {
	if (!msg.contentIsJson) return msg.content;
	const p = msg.parsedContent as Record<string, unknown> | undefined;
	if (!p) return msg.content;
	if (typeof p.text === "string" && p.text.trim()) return p.text;
	if (typeof p.result === "string" && p.result.trim()) return p.result;
	const m = isObj(p.message) ? p.message : null;
	if (m && typeof m.content === "string") return m.content;
	if (m && Array.isArray(m.content)) {
		const texts = (m.content as unknown[])
			.filter(
				(b): b is Record<string, unknown> =>
					isObj(b) && typeof b.text === "string",
			)
			.map((b) => b.text as string);
		if (texts.length > 0) return texts.join("\n\n");
	}
	return msg.content.slice(0, 200);
}

/**
 * Group child messages from nested sub-agents into collapsible sections.
 *
 * Strategy:
 * - Count how many distinct parent_tool_use_ids are in the child messages
 * - If there's only ONE parent (single-agent mode): render children INLINE
 *   by merging their parts into the conversation directly. This avoids
 *   hiding all tool calls under a collapsed Agent node.
 * - If there are MULTIPLE parents (multi-agent): group each parent's
 *   children into `__children__` on its Agent/Task tool-call.
 */
function groupChildMessages(msgs: ThreadMessageLike[]): ThreadMessageLike[] {
	// Quick check: are there any child messages at all?
	const hasChildren = msgs.some((m) => m.id?.startsWith("child:"));
	if (!hasChildren) return msgs;

	// Heuristic: count Agent/Task tool-calls in non-child messages
	let agentToolCount = 0;
	for (const m of msgs) {
		if (m.id?.startsWith("child:")) continue;
		if (m.role !== "assistant") continue;
		const parts = m.content as MessagePart[];
		for (const p of parts) {
			if (
				p.type === "tool-call" &&
				(p.toolName === "Agent" || p.toolName === "Task")
			) {
				agentToolCount++;
			}
		}
	}

	// Single-agent mode (0 or 1 Agent tool-calls): render children inline
	if (agentToolCount <= 1) {
		return inlineChildMessages(msgs);
	}

	// Multi-agent mode: group children under their parent Agent/Task
	return groupChildMessagesUnderParent(msgs);
}

/** Render child messages inline — strip the "child:" prefix and merge into conversation. */
function inlineChildMessages(msgs: ThreadMessageLike[]): ThreadMessageLike[] {
	const out: ThreadMessageLike[] = [];

	for (const m of msgs) {
		if (m.id?.startsWith("child:")) {
			// Strip child prefix and render as a normal assistant message
			out.push({
				...m,
				id: m.id.slice("child:".length),
			});
		} else {
			out.push(m);
		}
	}

	return out;
}

/** Group child messages under their parent Agent/Task tool-call (multi-agent mode). */
function groupChildMessagesUnderParent(
	msgs: ThreadMessageLike[],
): ThreadMessageLike[] {
	const out: ThreadMessageLike[] = [];

	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.id?.startsWith("child:")) {
			const parent = out[out.length - 1];
			if (parent?.role === "assistant") {
				const childParts: MessagePart[] = [];
				while (i < msgs.length && msgs[i].id?.startsWith("child:")) {
					const parts = msgs[i].content as MessagePart[];
					childParts.push(...parts);
					i++;
				}
				i--;

				const parentParts = parent.content as MessagePart[];
				const agentTc = [...parentParts]
					.reverse()
					.find(
						(p): p is ToolCallPart =>
							p.type === "tool-call" &&
							(p.toolName === "Agent" || p.toolName === "Task"),
					);
				if (agentTc) {
					agentTc.result = `__children__${JSON.stringify({ parts: childParts })}`;
				}
			}
			continue;
		}
		out.push(m);
	}

	return out;
}

// ---------------------------------------------------------------------------
// Collapse pass: group consecutive search/read tool-calls into summaries
// ---------------------------------------------------------------------------

function applyCollapsePass(messages: ThreadMessageLike[]): ThreadMessageLike[] {
	return messages.map((msg) => {
		if (msg.role !== "assistant") return msg;

		const parts = msg.content as MessagePart[];
		// Skip messages with no tool-calls
		if (!parts.some((p) => p.type === "tool-call")) return msg;

		const isStreaming = msg.status?.type !== "complete";
		const collapsed = collapseToolCallsInParts(parts, isStreaming);

		// If nothing was collapsed, return original reference (cache-friendly)
		if (
			collapsed.length === parts.length &&
			collapsed.every((p, i) => p === parts[i])
		) {
			return msg;
		}

		return { ...msg, content: collapsed };
	});
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function getRawMessageSignature(message: SessionMessageRecord): string {
	return [
		message.id,
		message.role,
		message.createdAt,
		message.contentIsJson ? "1" : "0",
		message.content,
	].join("\u0000");
}

function getRenderedMessageSignature(message: ThreadMessageLike): string {
	return JSON.stringify({
		id: message.id ?? null,
		role: message.role,
		status: message.status ?? null,
		content: message.content,
	});
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}

	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) {
			return false;
		}
	}

	return true;
}
