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
				[{ type: "text", text: "Let me inspect another file." }],
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
			assistant("a2", [toolCall("cmd2", "pnpm install")], true),
		]);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toHaveLength(2);
		expect(messages[0]?.content[0]?.type).toBe("tool-call");
		expect(messages[0]?.content[1]?.type).toBe("tool-call");
	});
});
