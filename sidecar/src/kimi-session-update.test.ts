import { describe, expect, test } from "bun:test";
import type { AcpSessionUpdate } from "./kimi-acp-types.js";
import {
	buildPromptBlocks,
	contentBlockToText,
	firstAnswerLabel,
	isSelectionRequest,
	toolContentText,
	translateSessionUpdate,
} from "./kimi-session-update.js";

const update = (u: Partial<AcpSessionUpdate> & { sessionUpdate: string }) =>
	translateSessionUpdate("ses_1", u as AcpSessionUpdate);

describe("translateSessionUpdate", () => {
	test("agent_message_chunk → text passthrough", () => {
		const out = update({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hello" },
		});
		expect(out.passthrough).toEqual({
			type: "kimi/agent_message_chunk",
			session_id: "ses_1",
			text: "hello",
		});
	});

	test("agent_thought_chunk → reasoning passthrough", () => {
		const out = update({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "thinking" },
		});
		expect(out.passthrough?.type).toBe("kimi/agent_thought_chunk");
		expect(out.passthrough?.text).toBe("thinking");
	});

	test("tool_call carries title/kind/status/raw_input but never raw_output", () => {
		const out = update({
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Read file",
			kind: "read",
			status: "pending",
			rawInput: { path: "a.ts" },
			rawOutput: { bytes: 12 },
		});
		expect(out.passthrough).toMatchObject({
			type: "kimi/tool_call",
			session_id: "ses_1",
			tool_call_id: "t1",
			title: "Read file",
			kind: "read",
			status: "pending",
			raw_input: { path: "a.ts" },
		});
		// raw_output is never rendered downstream — dropped to keep DB rows lean.
		expect(out.passthrough?.raw_output).toBeUndefined();
	});

	test("tool_call flattens content text + diff blocks", () => {
		const out = update({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "output line" } },
				{ type: "diff", path: "a.ts", oldText: "x", newText: "y" },
			],
		} as unknown as AcpSessionUpdate);
		expect(out.passthrough?.type).toBe("kimi/tool_call_update");
		expect(out.passthrough?.output_text).toBe("output line");
		expect(out.passthrough?.diffs).toEqual([
			{ path: "a.ts", old_text: "x", new_text: "y" },
		]);
	});

	test("plan normalizes entries", () => {
		const out = update({
			sessionUpdate: "plan",
			entries: [{ content: "step", priority: "high", status: "in_progress" }],
		});
		expect(out.passthrough).toEqual({
			type: "kimi/plan",
			session_id: "ses_1",
			entries: [{ content: "step", priority: "high", status: "in_progress" }],
		});
	});

	test("plan defaults missing fields", () => {
		const out = update({
			sessionUpdate: "plan",
			entries: [{ content: "step" }],
		});
		expect((out.passthrough?.entries as unknown[])[0]).toEqual({
			content: "step",
			priority: "medium",
			status: "pending",
		});
	});

	test("available_commands_update caches commands, no passthrough", () => {
		const out = update({
			sessionUpdate: "available_commands_update",
			availableCommands: [
				{ name: "compact", description: "Compact the context" },
				{ name: "", description: "dropped (no name)" },
			],
		});
		expect(out.passthrough).toBeUndefined();
		expect(out.commands).toEqual([
			{
				name: "compact",
				description: "Compact the context",
				argumentHint: undefined,
				source: "builtin",
			},
		]);
	});

	test("user_message_chunk + unknown updates are ignored", () => {
		expect(update({ sessionUpdate: "user_message_chunk" })).toEqual({});
		expect(update({ sessionUpdate: "current_mode_update" })).toEqual({});
		expect(update({ sessionUpdate: "usage_update" })).toEqual({});
	});
});

describe("contentBlockToText", () => {
	test("text / resource / resource_link", () => {
		expect(contentBlockToText({ type: "text", text: "a" })).toBe("a");
		expect(
			contentBlockToText({
				type: "resource",
				resource: { text: "b" },
			} as never),
		).toBe("b");
		expect(
			contentBlockToText({ type: "resource_link", uri: "file:///c" } as never),
		).toBe("file:///c");
		expect(contentBlockToText(undefined)).toBe("");
	});
});

describe("buildPromptBlocks", () => {
	test("text-only prompt", async () => {
		expect(await buildPromptBlocks("hi", [])).toEqual([
			{ type: "text", text: "hi" },
		]);
	});

	test("missing image degrades to an inline note, never throws", async () => {
		const blocks = await buildPromptBlocks("look", ["/nope/missing.png"]);
		expect(blocks[0]).toEqual({ type: "text", text: "look" });
		expect(blocks[1]).toEqual({
			type: "text",
			text: "[image unavailable: missing.png]",
		});
	});
});

describe("isSelectionRequest", () => {
	test("canonical tool approval (each kind once) → binary", () => {
		expect(
			isSelectionRequest([
				{ optionId: "approve_once", kind: "allow_once" },
				{ optionId: "approve_always", kind: "allow_always" },
				{ optionId: "reject", kind: "reject_once" },
			]),
		).toBe(false);
	});

	test("AskUserQuestion (N answers share allow_once) → selection", () => {
		expect(
			isSelectionRequest([
				{ optionId: "q0_opt_0", name: "Red", kind: "allow_once" },
				{ optionId: "q0_opt_1", name: "Blue", kind: "allow_once" },
				{ optionId: "q0_skip", name: "Skip", kind: "reject_once" },
			]),
		).toBe(true);
	});

	test("plan review fallback (Revise + Reject share reject_once) → selection", () => {
		expect(
			isSelectionRequest([
				{ optionId: "plan_approve", name: "Approve", kind: "allow_once" },
				{ optionId: "plan_revise", name: "Revise", kind: "reject_once" },
				{
					optionId: "plan_reject_and_exit",
					name: "Reject and Exit",
					kind: "reject_once",
				},
			]),
		).toBe(true);
	});

	test("single-answer question degrades to binary (Allow=answer, Deny=skip)", () => {
		expect(
			isSelectionRequest([
				{ optionId: "q0_opt_0", name: "Yes", kind: "allow_once" },
				{ optionId: "q0_skip", name: "Skip", kind: "reject_once" },
			]),
		).toBe(false);
	});
});

describe("firstAnswerLabel", () => {
	test("extracts the single-select label from the AUQ answers shape", () => {
		expect(firstAnswerLabel({ answers: { "Which color?": "Blue" } })).toBe(
			"Blue",
		);
	});

	test("takes the first label of a comma-joined multi answer", () => {
		expect(firstAnswerLabel({ answers: { q: "Red, Blue" } })).toBe("Red");
	});

	test("null on missing/empty answers", () => {
		expect(firstAnswerLabel(undefined)).toBeNull();
		expect(firstAnswerLabel({})).toBeNull();
		expect(firstAnswerLabel({ answers: { q: "" } })).toBeNull();
		expect(firstAnswerLabel({ answers: { q: 42 } })).toBeNull();
	});
});

describe("toolContentText", () => {
	test("flattens permission toolCall content blocks (question text)", () => {
		expect(
			toolContentText([
				{
					type: "content",
					content: { type: "text", text: "Which approach do you prefer?" },
				},
			]),
		).toBe("Which approach do you prefer?");
		expect(toolContentText(undefined)).toBe("");
	});
});
