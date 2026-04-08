/**
 * Streaming fixture loader.
 *
 * The on-disk fixture under `src/test/perf/fixtures/streaming-tool-use.jsonl`
 * is a verbatim capture of a real Claude Code SDK stream. The format is one
 * JSON object per line, where each event is one of:
 *
 *   - `{type: "system", ...}`              — session init / config
 *   - `{type: "stream_event", event: {...}, ...}` — Anthropic SSE event
 *   - `{type: "assistant", ...}`           — full message snapshot
 *   - `{type: "user", ...}`                — user-turn message snapshot
 *   - `{type: "result", ...}`              — final tool result / metadata
 *   - `{type: "rate_limit_event", ...}`    — sidecar telemetry
 *
 * For perf testing we only care about the `stream_event` rows because they
 * are what drive the live streaming render path. We replay them into a
 * synthetic `ThreadMessageLike` snapshot that grows over time, mirroring how
 * the Helmor pipeline (Rust agents.rs → frontend `liveMessages`) builds an
 * incremental assistant message. After every meaningful delta we emit a new
 * snapshot so the perf test can rerender the panel exactly as the production
 * stream would.
 */

import type {
	ExtendedMessagePart,
	MessagePart,
	ReasoningPart,
	TextPart,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";
// Vite supports `?raw` for importing file contents as a string at build time.
// This avoids depending on `@types/node` for `node:fs` and works in both
// vitest (via Vite's loader) and any bundled context.
import fixtureText from "./fixtures/streaming-tool-use.jsonl?raw";

// ---------------------------------------------------------------------------
// Raw stream event types — covers everything we need from the SDK shape
// ---------------------------------------------------------------------------

type RawThinkingDelta = {
	type: "thinking_delta";
	thinking: string;
};
type RawTextDelta = { type: "text_delta"; text: string };
type RawInputJsonDelta = { type: "input_json_delta"; partial_json: string };
type RawSignatureDelta = { type: "signature_delta"; signature: string };
type RawDelta =
	| RawThinkingDelta
	| RawTextDelta
	| RawInputJsonDelta
	| RawSignatureDelta;

type RawThinkingBlock = {
	type: "thinking";
	thinking?: string;
	signature?: string;
};
type RawTextBlock = { type: "text"; text?: string };
type RawToolUseBlock = {
	type: "tool_use";
	id: string;
	name: string;
	input?: unknown;
};
type RawContentBlock = RawThinkingBlock | RawTextBlock | RawToolUseBlock;

type RawSseEvent =
	| { type: "message_start"; message: { id: string; model: string } }
	| {
			type: "content_block_start";
			index: number;
			content_block: RawContentBlock;
	  }
	| { type: "content_block_delta"; index: number; delta: RawDelta }
	| { type: "content_block_stop"; index: number }
	| { type: "message_delta"; delta: { stop_reason?: string } }
	| { type: "message_stop" };

type RawJsonlRow =
	| { type: "system" }
	| {
			type: "stream_event";
			event: RawSseEvent;
			parent_tool_use_id?: string | null;
	  }
	| { type: "assistant"; message: { id: string } }
	| { type: "user" }
	| { type: "result" }
	| { type: "rate_limit_event" };

// ---------------------------------------------------------------------------
// Snapshot replay
// ---------------------------------------------------------------------------

export type StreamingSnapshot = {
	/**
	 * The complete `ThreadMessageLike[]` thread the panel should render after
	 * processing this event. Always includes the static history (passed in
	 * via `staticHistory`) plus the in-progress assistant message.
	 */
	thread: ThreadMessageLike[];
	/**
	 * The 0-indexed position of this snapshot in the replay sequence. Used by
	 * tests that want to throttle / sample.
	 */
	tick: number;
	/**
	 * The kind of delta that produced this snapshot. Useful for filtering or
	 * categorising in the perf report.
	 */
	deltaKind:
		| "thinking_delta"
		| "text_delta"
		| "tool_input_delta"
		| "block_start"
		| "block_stop";
};

let cachedRows: RawJsonlRow[] | null = null;

function loadRawRows(): RawJsonlRow[] {
	if (cachedRows) return cachedRows;
	const rows: RawJsonlRow[] = [];
	for (const line of fixtureText.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as RawJsonlRow);
		} catch {
			// Skip malformed lines — fixture is hand-edited capture, be tolerant.
		}
	}
	cachedRows = rows;
	return rows;
}

type IncrementalAssistantMessage = {
	id: string;
	role: "assistant";
	createdAt: string;
	content: ExtendedMessagePart[];
	streaming: boolean;
};

function newAssistantMessage(id: string): IncrementalAssistantMessage {
	return {
		id,
		role: "assistant",
		createdAt: new Date(0).toISOString(),
		content: [],
		streaming: true,
	};
}

function asTextPart(text: string): TextPart {
	return { type: "text", text };
}

function asReasoningPart(text: string): ReasoningPart {
	return { type: "reasoning", text, streaming: true };
}

function asToolCallPart(
	id: string,
	name: string,
	argsText: string,
): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: name,
		args: {},
		argsText,
		streamingStatus: "streaming_input",
	};
}

/**
 * Drive a fresh assistant message through every stream event in the fixture
 * and yield a `StreamingSnapshot` after every meaningful delta. The snapshot
 * thread is `[...staticHistory, currentAssistant]`, where `currentAssistant`
 * is structurally rebuilt on every delta — this faithfully reproduces what
 * the Tauri pipeline does (`shareMessages` keeps history identity stable but
 * the streaming tail gets a brand-new object reference each tick).
 *
 * Caller controls how many snapshots to consume via `limit`. Pass `Infinity`
 * for the full ~700-event replay; pass a smaller number for quick smoke
 * tests.
 */
export function* replayFixture(options: {
	staticHistory: ThreadMessageLike[];
	limit?: number;
}): Generator<StreamingSnapshot, void, unknown> {
	const rows = loadRawRows();
	const limit = options.limit ?? Number.POSITIVE_INFINITY;

	// Per-content-block builders. Index → builder. We rebuild the
	// `content` array on every emit, but the builders themselves accumulate
	// efficiently to avoid O(n²) string concatenation costs in the test.
	type Builder =
		| { kind: "thinking"; chunks: string[] }
		| { kind: "text"; chunks: string[] }
		| { kind: "tool_use"; id: string; name: string; chunks: string[] };
	const builders = new Map<number, Builder>();
	let assistant: IncrementalAssistantMessage | null = null;
	let tick = 0;

	const emitSnapshot = (
		deltaKind: StreamingSnapshot["deltaKind"],
	): StreamingSnapshot | null => {
		if (!assistant) return null;
		// Materialise content from builders (in index order). We sort the
		// keys explicitly so part order is stable even if events arrive
		// out-of-order.
		const indices = Array.from(builders.keys()).sort((a, b) => a - b);
		const content: ExtendedMessagePart[] = [];
		for (const i of indices) {
			const builder = builders.get(i)!;
			if (builder.kind === "thinking") {
				const text = builder.chunks.join("");
				if (text.length > 0) content.push(asReasoningPart(text));
			} else if (builder.kind === "text") {
				const text = builder.chunks.join("");
				if (text.length > 0) content.push(asTextPart(text));
			} else {
				const argsText = builder.chunks.join("");
				content.push(asToolCallPart(builder.id, builder.name, argsText));
			}
		}
		// New object identity for the assistant message every snapshot —
		// this is what `shareMessages` would produce in production.
		const nextAssistant: ThreadMessageLike = {
			id: assistant.id,
			role: "assistant",
			createdAt: assistant.createdAt,
			content,
			streaming: true,
		};
		const thread = [...options.staticHistory, nextAssistant];
		return { thread, tick: tick++, deltaKind };
	};

	for (const row of rows) {
		if (limit !== Number.POSITIVE_INFINITY && tick >= limit) {
			return;
		}
		if (row.type !== "stream_event") continue;
		const ev = row.event;

		if (ev.type === "message_start") {
			assistant = newAssistantMessage(ev.message.id);
			builders.clear();
			continue;
		}

		if (ev.type === "content_block_start") {
			const block = ev.content_block;
			if (block.type === "thinking") {
				builders.set(ev.index, { kind: "thinking", chunks: [] });
			} else if (block.type === "text") {
				builders.set(ev.index, { kind: "text", chunks: [] });
			} else if (block.type === "tool_use") {
				builders.set(ev.index, {
					kind: "tool_use",
					id: block.id,
					name: block.name,
					chunks: [],
				});
			}
			const snapshot = emitSnapshot("block_start");
			if (snapshot) yield snapshot;
			continue;
		}

		if (ev.type === "content_block_delta") {
			const builder = builders.get(ev.index);
			if (!builder) continue;
			const delta = ev.delta;
			if (delta.type === "thinking_delta" && builder.kind === "thinking") {
				builder.chunks.push(delta.thinking);
				const snapshot = emitSnapshot("thinking_delta");
				if (snapshot) yield snapshot;
			} else if (delta.type === "text_delta" && builder.kind === "text") {
				builder.chunks.push(delta.text);
				const snapshot = emitSnapshot("text_delta");
				if (snapshot) yield snapshot;
			} else if (
				delta.type === "input_json_delta" &&
				builder.kind === "tool_use"
			) {
				builder.chunks.push(delta.partial_json);
				const snapshot = emitSnapshot("tool_input_delta");
				if (snapshot) yield snapshot;
			}
			// signature_delta is silently dropped — it carries no rendered text
			continue;
		}

		if (ev.type === "content_block_stop") {
			const snapshot = emitSnapshot("block_stop");
			if (snapshot) yield snapshot;
		}
	}
}

/**
 * Convenience: count the total snapshots a full replay would emit. Used by
 * the perf test to set sane assertions / report sizes.
 */
export function countFixtureSnapshots(): number {
	let count = 0;
	const dummyHistory: ThreadMessageLike[] = [];
	for (const _ of replayFixture({ staticHistory: dummyHistory })) {
		count += 1;
	}
	return count;
}

/**
 * Quick re-export for tests that want raw row counts (not snapshots).
 */
export function countFixtureRows(): number {
	return loadRawRows().length;
}

// Re-export `MessagePart` so tests can re-use the type without re-importing
// from `@/lib/api`.
export type { MessagePart };
