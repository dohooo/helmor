/**
 * Regression tests for `messagesStructurallyEqual`.
 *
 * The structural-sharing helper backing `WorkspacePanelContainer` short-
 * circuits the `MemoConversationMessage` re-render path when a message
 * looks deeply equal to its previous incarnation. A previous version
 * skipped the `result` field on tool-call comparisons, which froze the
 * live render of in-progress subagents — Task tool calls carry their
 * children in `result` as a `__children__{...}` JSON string that grows
 * across pipeline emits, and the bail-out hid those updates from React.
 */

import { describe, expect, it } from "vitest";
import type { ThreadMessageLike, ToolCallPart } from "@/lib/api";
import { messagesStructurallyEqual } from "./workspace-panel-container";

function taskCallMessage(resultJson: string | undefined): ThreadMessageLike {
	const tool: ToolCallPart = {
		type: "tool-call",
		toolCallId: "task_a",
		toolName: "Task",
		args: { description: "subagent A", subagent_type: "Explore" },
		argsText: '{"description":"subagent A","subagent_type":"Explore"}',
		result: resultJson,
		streamingStatus: undefined,
	};
	return {
		role: "assistant",
		id: "msg-1",
		createdAt: "2026-04-08T00:00:00Z",
		content: [{ ...tool }],
		status: { type: "complete", reason: "stop" },
	};
}

describe("messagesStructurallyEqual — Task __children__ payloads", () => {
	it("returns false when a Task tool's __children__ payload grows", () => {
		const empty = taskCallMessage('__children__{"parts":[]}');
		const oneChild = taskCallMessage(
			'__children__{"parts":[{"type":"text","text":"A1"}]}',
		);
		expect(messagesStructurallyEqual(empty, oneChild)).toBe(false);
	});

	it("returns false as more children stream in", () => {
		const oneChild = taskCallMessage(
			'__children__{"parts":[{"type":"text","text":"A1"}]}',
		);
		const twoChildren = taskCallMessage(
			'__children__{"parts":[{"type":"text","text":"A1"},{"type":"text","text":"A2"}]}',
		);
		expect(messagesStructurallyEqual(oneChild, twoChildren)).toBe(false);
	});

	it("returns true when the __children__ payload is byte-identical", () => {
		const a = taskCallMessage(
			'__children__{"parts":[{"type":"text","text":"A1"}]}',
		);
		const b = taskCallMessage(
			'__children__{"parts":[{"type":"text","text":"A1"}]}',
		);
		expect(messagesStructurallyEqual(a, b)).toBe(true);
	});

	it("returns false when result transitions undefined → string", () => {
		const noResult = taskCallMessage(undefined);
		const withResult = taskCallMessage(
			'__children__{"parts":[{"type":"text","text":"A1"}]}',
		);
		expect(messagesStructurallyEqual(noResult, withResult)).toBe(false);
	});

	it("returns true for identical undefined-result tool calls", () => {
		const a = taskCallMessage(undefined);
		const b = taskCallMessage(undefined);
		expect(messagesStructurallyEqual(a, b)).toBe(true);
	});
});
