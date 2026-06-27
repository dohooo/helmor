import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { shouldSuppressCompactContextUsageMessage } from "./compact-filter.js";

/** Build a synthetic `## Context Usage` assistant message — the redundant
 * table the Claude Agent SDK emits after `/compact`. */
function syntheticContextUsageMessage(
	text = "## Context Usage\ntokens low",
): SDKMessage {
	return {
		type: "assistant",
		message: {
			model: "<synthetic>",
			content: [{ type: "text", text }],
		},
	} as unknown as SDKMessage;
}

function realAssistantMessage(text: string): SDKMessage {
	return {
		type: "assistant",
		message: {
			model: "claude-sonnet-4",
			content: [{ type: "text", text }],
		},
	} as unknown as SDKMessage;
}

describe("shouldSuppressCompactContextUsageMessage", () => {
	test("drops synthetic ## Context Usage message for /compact", () => {
		expect(
			shouldSuppressCompactContextUsageMessage(
				syntheticContextUsageMessage(),
				"/compact",
			),
		).toBe(true);
	});

	test("keeps synthetic ## Context Usage message for /context (useful output)", () => {
		expect(
			shouldSuppressCompactContextUsageMessage(
				syntheticContextUsageMessage(),
				"/context all",
			),
		).toBe(false);
	});

	test("keeps synthetic ## Context Usage message when no root slash command", () => {
		expect(
			shouldSuppressCompactContextUsageMessage(
				syntheticContextUsageMessage(),
				null,
			),
		).toBe(false);
	});

	test("keeps real (non-synthetic) assistant message even for /compact", () => {
		expect(
			shouldSuppressCompactContextUsageMessage(
				realAssistantMessage("## Context Usage\ntokens low"),
				"/compact",
			),
		).toBe(false);
	});

	test("keeps synthetic assistant message whose text is not ## Context Usage for /compact", () => {
		expect(
			shouldSuppressCompactContextUsageMessage(
				syntheticContextUsageMessage("Unrelated summary"),
				"/compact",
			),
		).toBe(false);
	});

	test("keeps non-assistant messages for /compact", () => {
		const systemMessage = {
			type: "system",
			subtype: "compact_boundary",
		} as unknown as SDKMessage;
		expect(
			shouldSuppressCompactContextUsageMessage(systemMessage, "/compact"),
		).toBe(false);
	});
});
