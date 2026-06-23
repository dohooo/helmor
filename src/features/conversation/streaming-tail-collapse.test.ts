import { describe, expect, it } from "vitest";
import type { ThreadMessageLike, ToolCallPart } from "@/lib/api";
import { stabilizeStreamingMessages } from "./streaming-tail-collapse";

function toolCall(
	id: string,
	command: string,
	streamingStatus: ToolCallPart["streamingStatus"] = "running",
): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: "Bash",
		args: { command },
		argsText: JSON.stringify({ command }),
		streamingStatus,
	};
}

function assistant(
	id: string,
	content: ThreadMessageLike["content"],
	streaming = true,
): ThreadMessageLike {
	return {
		id,
		role: "assistant",
		content,
		streaming,
	};
}

describe("stabilizeStreamingMessages", () => {
	it("captures the old flicker transition and stabilizes tick 2 into the final collapsed shape", () => {
		const tick1 = [
			assistant("a1", [toolCall("cmd1", "cat src/App.tsx")], true),
		];
		const tick2Raw = [
			...tick1,
			assistant(
				"a2",
				[toolCall("cmd2", "sed -n '1,40p' src/lib/api.ts")],
				true,
			),
		];

		expect(tick1).toHaveLength(1);
		expect(tick1[0]?.content[0]?.type).toBe("tool-call");

		// This is the pre-fix broken state: the second streaming tick shows
		// two separate command rows before a later full render collapses them.
		expect(tick2Raw).toHaveLength(2);
		expect(tick2Raw[0]?.content[0]?.type).toBe("tool-call");
		expect(tick2Raw[1]?.content[0]?.type).toBe("tool-call");

		const tick2Stabilized = stabilizeStreamingMessages(tick2Raw);

		// Desired behavior: as soon as the second compatible command arrives,
		// the UI already switches into the collapsed summary state.
		expect(tick2Stabilized).toHaveLength(1);
		const [merged] = tick2Stabilized;
		expect(merged?.content).toHaveLength(1);
		const [part] = merged?.content ?? [];
		expect(part?.type).toBe("collapsed-group");
		if (part?.type !== "collapsed-group") {
			throw new Error("expected collapsed-group");
		}
		expect(part.tools).toHaveLength(2);
		expect(part.summary).toBe("Running 2 read-only commands...");
		expect(part.active).toBe(true);
	});

	it("extends an existing collapsed group when another read-only command streams in", () => {
		const messages = stabilizeStreamingMessages([
			assistant(
				"a1",
				[
					{
						type: "collapsed-group",
						id: "group:cmd1",
						category: "shell",
						active: true,
						summary: "Running 2 read-only commands...",
						tools: [
							toolCall("cmd1", "cat src/App.tsx"),
							toolCall("cmd2", "sed -n '1,40p' src/lib/api.ts"),
						],
					},
				],
				true,
			),
			assistant("a2", [toolCall("cmd3", "nl -ba src/App.tsx")], true),
		]);

		expect(messages).toHaveLength(1);
		const [merged] = messages;
		const [part] = merged?.content ?? [];
		expect(part?.type).toBe("collapsed-group");
		if (part?.type !== "collapsed-group") {
			throw new Error("expected collapsed-group");
		}
		expect(part.tools).toHaveLength(3);
		expect(part.summary).toBe("Running 3 read-only commands...");
	});

	it("does not collapse across a text boundary", () => {
		const messages = stabilizeStreamingMessages([
			assistant("a1", [toolCall("cmd1", "cat src/App.tsx")], true),
			assistant(
				"a2",
				[
					{
						type: "text",
						id: "a2:txt:0",
						text: "Let me inspect another file.",
					},
				],
				true,
			),
			assistant(
				"a3",
				[toolCall("cmd2", "sed -n '1,40p' src/lib/api.ts")],
				true,
			),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(3);
		expect(messages[0]?.content[0]?.type).toBe("tool-call");
		expect(messages[0]?.content[1]?.type).toBe("text");
		expect(messages[0]?.content[2]?.type).toBe("tool-call");
	});

	it("does not collapse when the second command is not read-only", () => {
		const messages = stabilizeStreamingMessages([
			assistant("a1", [toolCall("cmd1", "cat src/App.tsx")], true),
			assistant("a2", [toolCall("cmd2", "bun install")], true),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(2);
		expect(messages[0]?.content[0]?.type).toBe("tool-call");
		expect(messages[0]?.content[1]?.type).toBe("tool-call");
	});

	it("dedupes one thinking block that surfaces in both the base snapshot and the pending partial", () => {
		// Omitted-thinking reproduction: a `system thinking_tokens` full render
		// (base) and the next streaming partial each carry the same reasoning
		// block (same `__part_id`, empty text). Must render ONE "Thinking…" chip.
		const reasoning = {
			type: "reasoning" as const,
			id: "turn-1:blk:0",
			text: "",
			streaming: true,
		};
		const messages = stabilizeStreamingMessages([
			assistant("a1", [{ ...reasoning }], true),
			assistant("a2", [{ ...reasoning }], true),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(1);
		expect(messages[0]?.content[0]?.type).toBe("reasoning");
	});

	it("merges adjacent thinking segments into one chip, summing durations", () => {
		// Omitted thinking splits ONE phase into several blocks with distinct
		// ids — one "Thought for Ns" chip per phase, not one per block.
		const messages = stabilizeStreamingMessages([
			assistant(
				"a1",
				[
					{
						type: "reasoning",
						id: "turn-1:blk:0",
						text: "First.",
						streaming: false,
						durationMs: 1200,
					},
				],
				true,
			),
			assistant(
				"a2",
				[
					{
						type: "reasoning",
						id: "turn-1:blk:2",
						text: "Second.",
						streaming: true,
						durationMs: 800,
					},
				],
				true,
			),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(1);
		const [part] = messages[0]?.content ?? [];
		if (part?.type !== "reasoning") {
			throw new Error("expected reasoning");
		}
		expect(part.id).toBe("turn-1:blk:0");
		expect(part.text).toBe("First.\n\nSecond.");
		expect(part.durationMs).toBe(2000);
		expect(part.streaming).toBe(true);
	});

	it("does not re-append in-flight reasoning text the base already absorbed", () => {
		// The pending partial re-sends the in-flight segment after the base
		// snapshot merged it — its text is already the tail of the chip.
		const messages = stabilizeStreamingMessages([
			assistant(
				"a1",
				[
					{
						type: "reasoning",
						id: "turn-1:blk:0",
						text: "First.\n\nSecond.",
						streaming: false,
						durationMs: 1200,
					},
				],
				true,
			),
			assistant(
				"a2",
				[
					{
						type: "reasoning",
						id: "turn-1:blk:2",
						text: "Second.",
						streaming: true,
					},
				],
				true,
			),
		]);

		expect(messages).toHaveLength(1);
		const [part] = messages[0]?.content ?? [];
		if (part?.type !== "reasoning") {
			throw new Error("expected reasoning");
		}
		expect(part.text).toBe("First.\n\nSecond.");
		expect(part.streaming).toBe(true);
	});

	it("flushes the group before reasoning so reads stay in thread order", () => {
		const messages = stabilizeStreamingMessages([
			assistant(
				"a1",
				[
					toolCall("cmd1", "cat a.go", "done"),
					toolCall("cmd2", "cat b.go", "done"),
				],
				true,
			),
			assistant(
				"a2",
				[
					{
						type: "reasoning",
						id: "turn-1:blk:0",
						text: "compare",
						streaming: true,
					},
				],
				true,
			),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(2);
		expect(messages[0]?.content[0]?.type).toBe("collapsed-group");
		expect(messages[0]?.content[1]?.type).toBe("reasoning");
	});

	it("dedupes a tool call the partial re-sends after the base finalized it", () => {
		// Phantom "+0 -0" reproduction: base carries the finalized Edit (full
		// args + result), the stale partial still carries the half-streamed
		// copy (empty args, live spinner). One card, the finalized one.
		const finalized: ToolCallPart = {
			type: "tool-call",
			toolCallId: "toolu_1",
			toolName: "Edit",
			args: { file_path: "a.go", old_string: "x", new_string: "y" },
			argsText: "",
			result: "ok",
			streamingStatus: "done",
		};
		const phantom: ToolCallPart = {
			type: "tool-call",
			toolCallId: "toolu_1",
			toolName: "Edit",
			args: {},
			argsText: "",
			streamingStatus: "streaming_input",
		};
		const messages = stabilizeStreamingMessages([
			assistant("a1", [finalized], false),
			assistant("a2", [phantom], true),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(1);
		const [part] = messages[0]?.content ?? [];
		if (part?.type !== "tool-call") {
			throw new Error("expected tool-call");
		}
		expect(part.result).toBe("ok");
		expect(part.args).toHaveProperty("file_path");
	});

	it("dedupes the assistant text the base snapshot and pending partial both carry", () => {
		// Live-streaming reproduction (cursor): the backend Full snapshot already
		// includes the in-flight assistant text, and the pending partial re-sends
		// the same text. Without text dedupe the bubble renders the paragraph twice.
		const dup = "仓库里没有单独的 `provider/` 根目录；";
		const messages = stabilizeStreamingMessages([
			assistant(
				"base",
				[toolCall("cmd1", "ls", "done"), { type: "text", id: "t0", text: dup }],
				true,
			),
			assistant("partial", [{ type: "text", id: "t1", text: dup }], true),
		]);

		expect(messages).toHaveLength(1);
		const textParts = (messages[0]?.content ?? []).filter(
			(p) => p.type === "text",
		);
		expect(textParts).toHaveLength(1);
		if (textParts[0]?.type !== "text") throw new Error("expected text");
		expect(textParts[0].text).toBe(dup);
	});

	it("keeps the longer copy when the partial text extends the base snapshot", () => {
		const messages = stabilizeStreamingMessages([
			assistant("base", [{ type: "text", id: "t0", text: "Hello" }], true),
			assistant(
				"partial",
				[{ type: "text", id: "t1", text: "Hello world" }],
				true,
			),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(1);
		const [part] = messages[0]?.content ?? [];
		if (part?.type !== "text") throw new Error("expected text");
		expect(part.text).toBe("Hello world");
	});

	it("does not merge two genuinely distinct adjacent text blocks", () => {
		const messages = stabilizeStreamingMessages([
			assistant(
				"base",
				[{ type: "text", id: "t0", text: "First paragraph." }],
				true,
			),
			assistant(
				"partial",
				[{ type: "text", id: "t1", text: "Different paragraph." }],
				true,
			),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(2);
	});
});
