/**
 * Truth-table tests for the memo / structural-sharing chain that keeps
 * the workspace panel from cascading re-renders on every stream tick.
 * The chain has four collaborating layers, and drift in any one of
 * them produces either stale-render bugs (false positive → "subagent
 * children frozen on last snapshot") or perf regressions (false
 * negative → "every sibling tick re-renders all finished subagents"):
 *
 *   1. `partStructurallyEqual` / `messagesStructurallyEqual` — content
 *      equality on `ThreadMessageLike` parts, including the typed
 *      `children` field on Task/Agent tool-calls.
 *   2. `shareMessages` (in `workspace-panel-container.tsx`) — reuses
 *      message references across `update` snapshots when the content
 *      is structurally equivalent, keeping the
 *      `MemoConversationMessage` `prev === next` bail-out alive.
 *   3. `assistantToolCallPropsEqual` — the `AssistantToolCall` memo
 *      comparator.
 *   4. `agentChildrenBlockPropsEqual` — the `AgentChildrenBlock` memo
 *      comparator.
 *
 * Component-level coverage of layers 3 + 4 also exists in
 * `workspace-panel.subagent.test.tsx`, which mounts `AssistantToolCall`
 * and asserts on the rendered DOM. Those tests catch invalidation
 * drift but can't isolate the bail-out path (where the comparator
 * returns `true` and React skips the render entirely) — a pure-
 * function test on the comparator is the only way to pin that intent
 * so a future refactor can't silently downgrade it to reference
 * equality.
 */

import { describe, expect, it } from "vitest";
import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";
import { shareMessages } from "@/lib/session-thread-cache";
import {
	childrenStructurallyEqual,
	messagesStructurallyEqual,
	partStructurallyEqual,
} from "@/lib/structural-equality";
import {
	agentChildrenBlockPropsEqual,
	assistantToolCallPropsEqual,
} from "./index";

function taskCallMessage(
	children: ExtendedMessagePart[] | undefined,
	result?: unknown,
): ThreadMessageLike {
	const tool: ToolCallPart = {
		type: "tool-call",
		toolCallId: "task_a",
		toolName: "Task",
		args: { description: "subagent A", subagent_type: "Explore" },
		argsText: '{"description":"subagent A","subagent_type":"Explore"}',
		result,
		streamingStatus: undefined,
		children,
	};
	return {
		role: "assistant",
		id: "msg-1",
		createdAt: "2026-04-08T00:00:00Z",
		content: [{ ...tool }],
		status: { type: "complete", reason: "stop" },
	};
}

function textPart(text: string): ExtendedMessagePart {
	return { type: "text", text };
}

describe("messagesStructurallyEqual — Task children payloads", () => {
	it("returns false when a Task tool's children list grows from empty", () => {
		const empty = taskCallMessage([]);
		const oneChild = taskCallMessage([textPart("A1")]);
		expect(messagesStructurallyEqual(empty, oneChild)).toBe(false);
	});

	it("returns false as more children stream in", () => {
		const oneChild = taskCallMessage([textPart("A1")]);
		const twoChildren = taskCallMessage([textPart("A1"), textPart("A2")]);
		expect(messagesStructurallyEqual(oneChild, twoChildren)).toBe(false);
	});

	it("returns true when the children list is structurally identical", () => {
		const a = taskCallMessage([textPart("A1")]);
		const b = taskCallMessage([textPart("A1")]);
		expect(messagesStructurallyEqual(a, b)).toBe(true);
	});

	it("returns false when an existing child's text mutates", () => {
		const a = taskCallMessage([textPart("A1")]);
		const b = taskCallMessage([textPart("A2")]);
		expect(messagesStructurallyEqual(a, b)).toBe(false);
	});

	it("returns false when children transitions undefined → populated", () => {
		const noChildren = taskCallMessage(undefined);
		const withChildren = taskCallMessage([textPart("A1")]);
		expect(messagesStructurallyEqual(noChildren, withChildren)).toBe(false);
	});

	it("returns true for identical childless tool calls", () => {
		const a = taskCallMessage(undefined);
		const b = taskCallMessage(undefined);
		expect(messagesStructurallyEqual(a, b)).toBe(true);
	});
});

/**
 * `childrenStructurallyEqual` is the helper the `AssistantToolCall` and
 * `AgentChildrenBlock` memo comparators use directly. Pin the same
 * cases as the message-level tests so the memo bail-out logic stays in
 * sync — if either path drops a check, both this suite and the suite
 * above should fail loudly.
 */
describe("childrenStructurallyEqual — memo comparator contract", () => {
	it("treats both undefined as equal", () => {
		expect(childrenStructurallyEqual(undefined, undefined)).toBe(true);
	});

	it("treats undefined and empty array as equal", () => {
		expect(childrenStructurallyEqual(undefined, [])).toBe(true);
		expect(childrenStructurallyEqual([], undefined)).toBe(true);
	});

	it("returns false when one side is undefined and the other is non-empty", () => {
		expect(childrenStructurallyEqual(undefined, [textPart("A1")])).toBe(false);
		expect(childrenStructurallyEqual([textPart("A1")], undefined)).toBe(false);
	});

	it("returns true when arrays are reference-equal", () => {
		const arr: ExtendedMessagePart[] = [textPart("A1")];
		expect(childrenStructurallyEqual(arr, arr)).toBe(true);
	});

	it("returns true when arrays are structurally identical but distinct", () => {
		const a = [textPart("A1"), textPart("A2")];
		const b = [textPart("A1"), textPart("A2")];
		expect(childrenStructurallyEqual(a, b)).toBe(true);
	});

	it("returns false when one child is appended", () => {
		const a = [textPart("A1")];
		const b = [textPart("A1"), textPart("A2")];
		expect(childrenStructurallyEqual(a, b)).toBe(false);
	});

	it("returns false when an existing child's content mutates", () => {
		const a = [textPart("A1")];
		const b = [textPart("A2")];
		expect(childrenStructurallyEqual(a, b)).toBe(false);
	});
});

/**
 * Direct tests for `partStructurallyEqual` branches that aren't
 * exercised transitively through the `messagesStructurallyEqual` and
 * `childrenStructurallyEqual` cases above. The text and tool-call
 * branches are well covered by the suites above (every Task fixture
 * walks through them); reasoning and collapsed-group are not, so a
 * regression in those branches would slip past silently. Also covers
 * the `result`-as-string vs reference fallback logic on `tool-call`
 * since that's a special-cased branch worth pinning.
 */
describe("partStructurallyEqual — direct branch coverage", () => {
	it("treats reasoning parts equal when text and streaming match", () => {
		const a: ExtendedMessagePart = {
			type: "reasoning",
			text: "Considering the request",
			streaming: false,
		};
		const b: ExtendedMessagePart = {
			type: "reasoning",
			text: "Considering the request",
			streaming: false,
		};
		expect(partStructurallyEqual(a, b)).toBe(true);
	});

	it("invalidates reasoning parts when text differs", () => {
		const a: ExtendedMessagePart = { type: "reasoning", text: "first" };
		const b: ExtendedMessagePart = { type: "reasoning", text: "second" };
		expect(partStructurallyEqual(a, b)).toBe(false);
	});

	it("invalidates reasoning parts when only the streaming flag flips", () => {
		// `streaming` matters: while a reasoning block is mid-stream the UI
		// renders a live indicator that has to disappear when the flag
		// flips to undefined/false. Dropping this check would freeze the
		// indicator on the post-completion render.
		const a: ExtendedMessagePart = {
			type: "reasoning",
			text: "same body",
			streaming: true,
		};
		const b: ExtendedMessagePart = {
			type: "reasoning",
			text: "same body",
			streaming: false,
		};
		expect(partStructurallyEqual(a, b)).toBe(false);
	});

	function group(
		overrides: Partial<CollapsedGroupPart> = {},
	): CollapsedGroupPart {
		return {
			type: "collapsed-group",
			active: false,
			category: "read",
			summary: "Read 3 files",
			tools: [
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "Read",
					args: { file_path: "/a" },
					argsText: '{"file_path":"/a"}',
				},
			],
			...overrides,
		};
	}

	it("treats two collapsed-group parts equal when every field matches", () => {
		expect(partStructurallyEqual(group(), group())).toBe(true);
	});

	it("invalidates a collapsed-group part when active flips", () => {
		// `active` drives the live spinner on the group header — drifting
		// here would freeze the spinner across the inactive→complete
		// transition.
		expect(
			partStructurallyEqual(group({ active: false }), group({ active: true })),
		).toBe(false);
	});

	it("invalidates a collapsed-group part when summary text changes", () => {
		expect(
			partStructurallyEqual(
				group({ summary: "Read 3 files" }),
				group({ summary: "Read 4 files" }),
			),
		).toBe(false);
	});

	it("invalidates a collapsed-group part when category differs", () => {
		expect(
			partStructurallyEqual(
				group({ category: "read" }),
				group({ category: "search" }),
			),
		).toBe(false);
	});

	it("invalidates a collapsed-group part when an inner tool's content changes", () => {
		const a = group({
			tools: [
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "Read",
					args: { file_path: "/a" },
					argsText: '{"file_path":"/a"}',
				},
			],
		});
		const b = group({
			tools: [
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "Read",
					args: { file_path: "/b" },
					argsText: '{"file_path":"/b"}',
				},
			],
		});
		expect(partStructurallyEqual(a, b)).toBe(false);
	});

	it("invalidates a collapsed-group part when tool count differs", () => {
		const a = group();
		const b = group({
			tools: [
				...group().tools,
				{
					type: "tool-call",
					toolCallId: "call_2",
					toolName: "Read",
					args: { file_path: "/c" },
					argsText: '{"file_path":"/c"}',
				},
			],
		});
		expect(partStructurallyEqual(a, b)).toBe(false);
	});

	it("compares tool-call results by value when both sides are strings", () => {
		// String results land in the DB as raw strings (e.g. shell stdout
		// or a Read snapshot), and the persistence path can produce a
		// fresh string reference for byte-identical content. Reference
		// comparison alone would force a re-render every snapshot.
		const a: ToolCallPart = {
			type: "tool-call",
			toolCallId: "call_1",
			toolName: "Bash",
			args: { command: "ls" },
			argsText: '{"command":"ls"}',
			result: "total 0",
		};
		const b: ToolCallPart = {
			...a,
			// Different reference, same content — String() forces a fresh
			// allocation that the JS engine won't intern back to the same
			// reference, so this exercises the value-compare branch.
			result: String(`total ${0}`),
		};
		expect(partStructurallyEqual(a, b)).toBe(true);
	});

	it("invalidates tool-call parts when string results differ", () => {
		const a: ToolCallPart = {
			type: "tool-call",
			toolCallId: "call_1",
			toolName: "Bash",
			args: { command: "ls" },
			argsText: '{"command":"ls"}',
			result: "total 0",
		};
		const b: ToolCallPart = { ...a, result: "total 5" };
		expect(partStructurallyEqual(a, b)).toBe(false);
	});
});

/**
 * `shareMessages` is the structural-sharing helper that decides whether
 * a previous `ThreadMessageLike` reference can be reused across the
 * Tauri stream pipeline's `update` snapshots. It's the load-bearing
 * piece that keeps the `MemoConversationMessage` `prev === next`
 * bail-out alive — every per-message memo downstream depends on it.
 *
 * The truth table tested here:
 *   - prev === next            → return next as-is (no work).
 *   - all messages reused      → return PREV (so the outer reference
 *                                stays stable for the parent memo).
 *   - any new/changed message  → return the SHARED array (a new
 *                                reference) so React notices the
 *                                update.
 */
describe("shareMessages — structural reference reuse", () => {
	function userMsg(id: string, text: string): ThreadMessageLike {
		return {
			role: "user",
			id,
			createdAt: "2026-04-08T00:00:00Z",
			content: [{ type: "text", text }],
		};
	}

	it("returns the next array unchanged when references are identical", () => {
		const arr = [userMsg("m1", "hello")];
		expect(shareMessages(arr, arr)).toBe(arr);
	});

	it("returns the previous array reference when every message is structurally identical", () => {
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const result = shareMessages(prev, next);
		// Outer reference must be `prev` so the container memo above
		// shareMessages can short-circuit on its `prev === next` check.
		expect(result).toBe(prev);
	});

	it("reuses individual message references when content matches by id", () => {
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "changed")];
		const result = shareMessages(prev, next);
		// New outer reference (m2 changed), but m1 must still point to
		// the previous object so its per-message memo can bail out.
		expect(result).not.toBe(prev);
		expect(result[0]).toBe(prev[0]);
		expect(result[1]).not.toBe(prev[1]);
		expect(result[1]).toBe(next[1]);
	});

	it("returns a new outer reference when length grows", () => {
		const prev = [userMsg("m1", "hello")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const result = shareMessages(prev, next);
		expect(result).not.toBe(prev);
		expect(result).toHaveLength(2);
		expect(result[0]).toBe(prev[0]);
	});

	it("returns a new outer reference when length shrinks", () => {
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello")];
		const result = shareMessages(prev, next);
		expect(result).not.toBe(prev);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(prev[0]);
	});

	it("does not reuse a previous message when its id is missing from next", () => {
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello"), userMsg("m3", "different")];
		const result = shareMessages(prev, next);
		expect(result[0]).toBe(prev[0]);
		// m3 wasn't in prev, so it must be the new object (no reuse).
		expect(result[1]).toBe(next[1]);
	});

	it("falls through to the new message when ids match but content differs", () => {
		const prev = [userMsg("m1", "hello")];
		const next = [userMsg("m1", "different content")];
		const result = shareMessages(prev, next);
		// Same id but content differs → must NOT reuse the prev ref.
		expect(result[0]).toBe(next[0]);
	});

	it("handles empty arrays without crashing", () => {
		const prev: ThreadMessageLike[] = [];
		const next: ThreadMessageLike[] = [];
		expect(shareMessages(prev, next)).toBe(prev);
	});
});

/**
 * Direct tests for the `AssistantToolCall` memo comparator. The
 * component-level subagent tests (`workspace-panel.subagent.test.tsx`)
 * verify that the rendered DOM updates when content changes — those
 * tests catch the false-positive direction (comparator wrongly
 * returning `true` and serving stale content). The bail-out direction
 * (comparator correctly returning `true` so React skips the render)
 * can't be observed from the rendered DOM and is pinned here as a
 * pure-function contract.
 */
describe("assistantToolCallPropsEqual — memo bail-out contract", () => {
	const baseProps = {
		toolName: "Bash",
		args: { command: "ls -la" },
		result: "total 0",
		streamingStatus: undefined,
		compact: false,
		childParts: undefined,
	} as const;

	it("returns true for identical props", () => {
		expect(
			assistantToolCallPropsEqual({ ...baseProps }, { ...baseProps }),
		).toBe(true);
	});

	it("returns true when args reference changes but values are shallow-equal", () => {
		// Stream ticks frequently rebuild the args object (e.g. mutating
		// one field), so a shallow value compare is the right fidelity.
		const next = { ...baseProps, args: { command: "ls -la" } };
		expect(assistantToolCallPropsEqual({ ...baseProps }, next)).toBe(true);
	});

	it("returns false when toolName changes", () => {
		expect(
			assistantToolCallPropsEqual(
				{ ...baseProps },
				{ ...baseProps, toolName: "Read" },
			),
		).toBe(false);
	});

	it("returns false when streamingStatus transitions", () => {
		expect(
			assistantToolCallPropsEqual(
				{ ...baseProps, streamingStatus: "running" },
				{ ...baseProps, streamingStatus: undefined },
			),
		).toBe(false);
	});

	it("returns false when result reference changes (non-string)", () => {
		// Non-string results (parsed JSON) are compared by reference —
		// the accumulator either reuses the same object or builds a new
		// one when content actually changes.
		const a = { ...baseProps, result: { ok: true } };
		const b = { ...baseProps, result: { ok: true } };
		expect(assistantToolCallPropsEqual(a, b)).toBe(false);
	});

	it("returns false when compact toggles", () => {
		expect(
			assistantToolCallPropsEqual(
				{ ...baseProps, compact: false },
				{ ...baseProps, compact: true },
			),
		).toBe(false);
	});

	it("returns false when an arg value changes", () => {
		expect(
			assistantToolCallPropsEqual(
				{ ...baseProps, args: { command: "ls -la" } },
				{ ...baseProps, args: { command: "ls" } },
			),
		).toBe(false);
	});

	it("returns false when an arg key is added", () => {
		expect(
			assistantToolCallPropsEqual(
				{ ...baseProps, args: { command: "ls" } },
				{ ...baseProps, args: { command: "ls", description: "list" } },
			),
		).toBe(false);
	});

	// THE bail-out path: a sibling subagent's stream tick rebuilds this
	// tool-call's `childParts` array reference, but the underlying
	// content didn't change. The comparator MUST return true so React
	// skips the re-render. If it ever returns false here, every
	// sibling tick re-renders every finished subagent's tree.
	it("returns true when childParts is content-equal but reference-different", () => {
		const a = {
			...baseProps,
			toolName: "Task",
			args: { description: "Explore", subagent_type: "Explore" },
			childParts: [
				{ type: "text", text: "step 1" } as ExtendedMessagePart,
				{ type: "text", text: "step 2" } as ExtendedMessagePart,
			],
		};
		const b = {
			...a,
			childParts: [
				{ type: "text", text: "step 1" } as ExtendedMessagePart,
				{ type: "text", text: "step 2" } as ExtendedMessagePart,
			],
		};
		// Sanity check that we constructed distinct references.
		expect(a.childParts).not.toBe(b.childParts);
		expect(assistantToolCallPropsEqual(a, b)).toBe(true);
	});

	it("returns false when a childPart is appended", () => {
		const a = {
			...baseProps,
			toolName: "Task",
			args: { description: "Explore", subagent_type: "Explore" },
			childParts: [{ type: "text", text: "step 1" } as ExtendedMessagePart],
		};
		const b = {
			...a,
			childParts: [
				{ type: "text", text: "step 1" } as ExtendedMessagePart,
				{ type: "text", text: "step 2" } as ExtendedMessagePart,
			],
		};
		expect(assistantToolCallPropsEqual(a, b)).toBe(false);
	});

	it("returns false when an existing childPart's content mutates", () => {
		const a = {
			...baseProps,
			toolName: "Task",
			args: { description: "Explore", subagent_type: "Explore" },
			childParts: [{ type: "text", text: "step 1" } as ExtendedMessagePart],
		};
		const b = {
			...a,
			childParts: [
				{ type: "text", text: "step 1 updated" } as ExtendedMessagePart,
			],
		};
		expect(assistantToolCallPropsEqual(a, b)).toBe(false);
	});
});

/**
 * Direct tests for the `AgentChildrenBlock` memo comparator.
 *
 * Unlike `assistantToolCallPropsEqual`, this comparator's bail-out
 * behavior has NO indirect coverage from any DOM-level test in the
 * suite — when `parts` changes content, both reference equality and
 * structural equality correctly invalidate, so the choice between
 * them is invisible to the rendered DOM. The performance intent
 * (skip re-render when content is identical but reference differs)
 * can only be pinned by a pure-function test on the comparator.
 *
 * This block is what stops a future refactor from silently
 * downgrading `parts` to reference equality, which would cascade a
 * re-render of every finished subagent's expanded children on every
 * sibling subagent's stream tick.
 */
describe("agentChildrenBlockPropsEqual — memo bail-out contract", () => {
	const baseProps = {
		toolName: "Task",
		toolArgs: { description: "Explore frontend", subagent_type: "Explore" },
		streamingStatus: undefined,
		parts: [] as ExtendedMessagePart[],
	};

	it("returns true for identical props", () => {
		expect(
			agentChildrenBlockPropsEqual({ ...baseProps }, { ...baseProps }),
		).toBe(true);
	});

	// THE bail-out path. Without `childrenStructurallyEqual` this
	// would return false for every sibling stream tick.
	it("returns true when parts is content-equal but reference-different", () => {
		const a = {
			...baseProps,
			parts: [
				{ type: "text", text: "step 1" } as ExtendedMessagePart,
				{ type: "text", text: "step 2" } as ExtendedMessagePart,
			],
		};
		const b = {
			...baseProps,
			parts: [
				{ type: "text", text: "step 1" } as ExtendedMessagePart,
				{ type: "text", text: "step 2" } as ExtendedMessagePart,
			],
		};
		expect(a.parts).not.toBe(b.parts);
		expect(agentChildrenBlockPropsEqual(a, b)).toBe(true);
	});

	it("returns false when toolName changes", () => {
		expect(
			agentChildrenBlockPropsEqual(
				{ ...baseProps },
				{ ...baseProps, toolName: "Agent" },
			),
		).toBe(false);
	});

	it("returns false when streamingStatus transitions", () => {
		expect(
			agentChildrenBlockPropsEqual(
				{ ...baseProps, streamingStatus: "running" },
				{ ...baseProps, streamingStatus: undefined },
			),
		).toBe(false);
	});

	it("returns false when toolArgs values change", () => {
		expect(
			agentChildrenBlockPropsEqual(
				{
					...baseProps,
					toolArgs: { description: "A", subagent_type: "Explore" },
				},
				{
					...baseProps,
					toolArgs: { description: "B", subagent_type: "Explore" },
				},
			),
		).toBe(false);
	});

	it("returns false when parts grows by one", () => {
		const a = {
			...baseProps,
			parts: [{ type: "text", text: "step 1" } as ExtendedMessagePart],
		};
		const b = {
			...baseProps,
			parts: [
				{ type: "text", text: "step 1" } as ExtendedMessagePart,
				{ type: "text", text: "step 2" } as ExtendedMessagePart,
			],
		};
		expect(agentChildrenBlockPropsEqual(a, b)).toBe(false);
	});

	it("returns false when an existing part's content mutates", () => {
		const a = {
			...baseProps,
			parts: [{ type: "text", text: "step 1" } as ExtendedMessagePart],
		};
		const b = {
			...baseProps,
			parts: [{ type: "text", text: "step 1 updated" } as ExtendedMessagePart],
		};
		expect(agentChildrenBlockPropsEqual(a, b)).toBe(false);
	});
});
