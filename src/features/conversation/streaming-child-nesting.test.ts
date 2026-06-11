import { describe, expect, it } from "vitest";
import type { ThreadMessageLike, ToolCallPart } from "@/lib/api";
import { nestStreamingChildPartial } from "./streaming-child-nesting";

function agentToolCall(
	id: string,
	children: ToolCallPart["children"] = [],
): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: "Agent",
		args: {},
		argsText: "{}",
		children,
	};
}

function assistant(
	id: string,
	content: ThreadMessageLike["content"],
): ThreadMessageLike {
	return { id, role: "assistant", content, streaming: true };
}

describe("nestStreamingChildPartial", () => {
	it("nests a child partial under the matching tool call instead of top-level", () => {
		const base = [
			{ id: "u1", role: "user", content: [] } as ThreadMessageLike,
			assistant("a1", [agentToolCall("toolu_agent")]),
		];
		const partial = assistant("child:toolu_agent:turn-9", [
			{ type: "text", id: "t0", text: "Looking into the repo..." },
		]);

		const result = nestStreamingChildPartial(base, partial);
		expect(result).not.toBeNull();
		// Still 2 top-level messages — no extra bubble.
		expect(result).toHaveLength(2);
		const tool = result![1]!.content[0] as ToolCallPart;
		expect(tool.type).toBe("tool-call");
		expect(tool.children).toHaveLength(1);
		expect(tool.children?.[0]).toMatchObject({ type: "text" });
	});

	it("appends to existing finalized children rather than replacing them", () => {
		const finalized: ToolCallPart["children"] = [
			{ type: "text", id: "done", text: "Earlier turn." },
		];
		const base = [assistant("a1", [agentToolCall("toolu_agent", finalized)])];
		const partial = assistant("child:toolu_agent:turn-2", [
			{ type: "text", id: "t1", text: "Streaming now." },
		]);

		const result = nestStreamingChildPartial(base, partial);
		const tool = result![0]!.content[0] as ToolCallPart;
		expect(tool.children).toHaveLength(2);
	});

	it("recurses into nested tool calls (Agent under Workflow)", () => {
		const base = [
			assistant("a1", [
				{
					type: "tool-call",
					toolCallId: "toolu_workflow",
					toolName: "Workflow",
					args: {},
					argsText: "{}",
					children: [agentToolCall("toolu_agent")],
				} as ToolCallPart,
			]),
		];
		const partial = assistant("child:toolu_agent:turn-3", [
			{ type: "text", id: "t2", text: "Nested." },
		]);

		const result = nestStreamingChildPartial(base, partial);
		expect(result).not.toBeNull();
		const workflow = result![0]!.content[0] as ToolCallPart;
		const agent = workflow.children?.[0] as ToolCallPart;
		expect(agent.children).toHaveLength(1);
	});

	it("returns null for a non-child (top-level) partial", () => {
		const base = [assistant("a1", [agentToolCall("toolu_agent")])];
		const partial = assistant("plain-uuid", [
			{ type: "text", id: "t3", text: "Top level." },
		]);
		expect(nestStreamingChildPartial(base, partial)).toBeNull();
	});

	it("returns null when no matching parent tool call exists (orphan)", () => {
		const base = [assistant("a1", [agentToolCall("toolu_other")])];
		const partial = assistant("child:toolu_missing:turn-4", [
			{ type: "text", id: "t4", text: "Orphan." },
		]);
		expect(nestStreamingChildPartial(base, partial)).toBeNull();
	});
});
