import { describe, expect, it } from "vitest";
import type { SessionMessageRecord } from "./api";
import { convertMessages } from "./message-adapter";

function msg(
	overrides: Partial<SessionMessageRecord> & Pick<SessionMessageRecord, "id">,
): SessionMessageRecord {
	return {
		id: overrides.id,
		sessionId: overrides.sessionId ?? "sess-1",
		role: overrides.role ?? "assistant",
		content: overrides.content ?? "",
		contentIsJson: overrides.contentIsJson ?? true,
		parsedContent: overrides.parsedContent,
		createdAt: overrides.createdAt ?? "2026-04-06T00:00:00.000Z",
		sentAt: overrides.sentAt ?? null,
		cancelledAt: overrides.cancelledAt ?? null,
		model: overrides.model ?? null,
		sdkMessageId: overrides.sdkMessageId ?? null,
		lastAssistantMessageId: overrides.lastAssistantMessageId ?? null,
		turnId: overrides.turnId ?? null,
		isResumableMessage: overrides.isResumableMessage ?? null,
		attachmentCount: overrides.attachmentCount ?? 0,
	};
}

describe("convertMessages", () => {
	it("merges adjacent assistant tool turns into one UI assistant message", () => {
		const messages: SessionMessageRecord[] = [
			msg({
				id: "assistant-1",
				parsedContent: {
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "Bash",
								input: { command: "ls -la" },
							},
						],
					},
				},
				content: JSON.stringify({
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "Bash",
								input: { command: "ls -la" },
							},
						],
					},
				}),
			}),
			msg({
				id: "tool-result-1",
				role: "user",
				parsedContent: {
					type: "user",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-1",
								content: "file-a\nfile-b",
							},
						],
					},
				},
				content: JSON.stringify({
					type: "user",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-1",
								content: "file-a\nfile-b",
							},
						],
					},
				}),
			}),
			msg({
				id: "assistant-2",
				parsedContent: {
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool-2",
								name: "Read",
								input: { file_path: "/tmp/example.txt" },
							},
						],
					},
				},
				content: JSON.stringify({
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool-2",
								name: "Read",
								input: { file_path: "/tmp/example.txt" },
							},
						],
					},
				}),
			}),
			msg({
				id: "tool-result-2",
				role: "user",
				parsedContent: {
					type: "user",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-2",
								content: "hello world",
							},
						],
					},
				},
				content: JSON.stringify({
					type: "user",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-2",
								content: "hello world",
							},
						],
					},
				}),
			}),
		];

		const rendered = convertMessages(messages, "sess-1");

		expect(rendered).toHaveLength(1);
		expect(rendered[0].role).toBe("assistant");
		expect(rendered[0].id).toBe("assistant-1");
		expect(rendered[0].content).toHaveLength(2);
	});

	it("does not merge assistant messages across a real user turn", () => {
		const messages: SessionMessageRecord[] = [
			msg({
				id: "assistant-1",
				parsedContent: {
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
				},
				content: JSON.stringify({
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
				}),
			}),
			msg({
				id: "user-1",
				role: "user",
				contentIsJson: false,
				content: "next question",
				parsedContent: undefined,
			}),
			msg({
				id: "assistant-2",
				parsedContent: {
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "world" }],
					},
				},
				content: JSON.stringify({
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "world" }],
					},
				}),
			}),
		];

		const rendered = convertMessages(messages, "sess-2");

		expect(rendered).toHaveLength(3);
		expect(rendered[0].role).toBe("assistant");
		expect(rendered[1].role).toBe("user");
		expect(rendered[2].role).toBe("assistant");
	});
});
