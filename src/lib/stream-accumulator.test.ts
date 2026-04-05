import { describe, expect, it } from "vitest";
import { StreamAccumulator } from "./stream-accumulator";

describe("StreamAccumulator", () => {
	// -----------------------------------------------------------------------
	// Claude events
	// -----------------------------------------------------------------------

	describe("Claude events", () => {
		it("accumulates stream_event text deltas", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { text: "Hello " } },
				}),
			);
			acc.addLine(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { text: "world" } },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			// Should have a partial message with accumulated text
			expect(messages.length).toBeGreaterThanOrEqual(1);
			const last = messages[messages.length - 1];
			expect(last.content).toContain("Hello world");
		});

		it("accumulates thinking deltas", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { thinking: "Let me think..." } },
				}),
			);
			acc.addLine(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { text: "Answer" } },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			const last = messages[messages.length - 1];
			expect(last.contentIsJson).toBe(true);
			const parsed = last.parsedContent as Record<string, unknown>;
			expect(parsed.type).toBe("assistant");
		});

		it("collects full assistant messages", () => {
			const acc = new StreamAccumulator();
			const assistantMsg = {
				type: "assistant",
				message: {
					id: "msg-1",
					content: [{ type: "text", text: "Full response" }],
				},
			};
			acc.addLine(JSON.stringify(assistantMsg));

			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBe(1);
			expect(messages[0].role).toBe("assistant");
			expect(messages[0].contentIsJson).toBe(true);
		});

		it("collects user messages (tool results)", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({
					type: "user",
					message: { content: [{ type: "tool_result", output: "done" }] },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBe(1);
			expect(messages[0].role).toBe("user");
		});

		it("collects result messages", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({
					type: "result",
					result: "Final answer",
					usage: { input_tokens: 10, output_tokens: 5 },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBe(1);
			expect(messages[0].role).toBe("assistant");
		});

		it("collects error messages", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({ type: "error", message: "Something broke" }),
			);

			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBe(1);
			expect(messages[0].role).toBe("error");
		});

		it("resets deltas after full assistant message", () => {
			const acc = new StreamAccumulator();
			// Accumulate some deltas
			acc.addLine(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { text: "partial" } },
				}),
			);
			// Then a full message arrives
			acc.addLine(
				JSON.stringify({
					type: "assistant",
					message: {
						content: [{ type: "text", text: "full response" }],
					},
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			// Should only have the full message, no trailing partial
			expect(messages.length).toBe(1);
			expect(messages[0].role).toBe("assistant");
		});
	});

	// -----------------------------------------------------------------------
	// Codex events
	// -----------------------------------------------------------------------

	describe("Codex events", () => {
		it("collects item.completed agent_message", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "Hello from Codex" },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			// Should have the collected message + a trailing partial from delta accumulation
			const assistantMsgs = messages.filter((m) => m.role === "assistant");
			expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
			// The collected message should contain the Codex event
			const collected = assistantMsgs.find((m) => m.contentIsJson);
			expect(collected).toBeDefined();
		});

		it("ignores non-agent_message items", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({
					type: "item.completed",
					item: { type: "command_execution", command: "ls" },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			// No assistant messages should be collected
			const assistantMsgs = messages.filter((m) => m.role === "assistant");
			expect(assistantMsgs.length).toBe(0);
		});

		it("collects turn.completed", () => {
			const acc = new StreamAccumulator();
			acc.addLine(
				JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "Response" },
				}),
			);
			acc.addLine(
				JSON.stringify({
					type: "turn.completed",
					usage: { input_tokens: 100, output_tokens: 20 },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			// Should include both the item.completed and turn.completed as collected messages
			// (plus a trailing partial from delta accumulation)
			const assistantMsgs = messages.filter((m) => m.role === "assistant");
			expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------

	describe("edge cases", () => {
		it("handles invalid JSON gracefully", () => {
			const acc = new StreamAccumulator();
			acc.addLine("not json at all");
			acc.addLine("{broken json");

			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBe(0);
		});

		it("handles unknown event types gracefully", () => {
			const acc = new StreamAccumulator();
			acc.addLine(JSON.stringify({ type: "unknown_event", data: "foo" }));

			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBe(0);
		});

		it("handles empty lines", () => {
			const acc = new StreamAccumulator();
			acc.addLine("");
			acc.addLine("   ");

			// Should not crash
			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBe(0);
		});

		it("toPartialMessage returns placeholder when empty", () => {
			const acc = new StreamAccumulator();
			const partial = acc.toPartialMessage("ctx", "sess");
			expect(partial.content).toBe("...");
		});

		it("handles mixed Claude and Codex events", () => {
			const acc = new StreamAccumulator();
			// This shouldn't happen in practice, but should not crash
			acc.addLine(
				JSON.stringify({
					type: "stream_event",
					event: { delta: { text: "Claude" } },
				}),
			);
			acc.addLine(
				JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "Codex" },
				}),
			);

			const messages = acc.toMessages("ctx", "sess");
			expect(messages.length).toBeGreaterThan(0);
		});
	});
});
