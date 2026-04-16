import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { MemoConversationMessage } from "./message-components";
import { serializeMessageForClipboard } from "./message-components/copy-message";
import { AssistantToolCall } from "./message-components/tool-call";

let writeTextMock: ReturnType<typeof vi.fn>;

afterEach(() => {
	cleanup();
});

beforeEach(() => {
	writeTextMock = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: writeTextMock,
		},
	});
});

function createPlanReviewMessage(): ThreadMessageLike {
	return {
		id: "plan-message-1",
		role: "assistant",
		createdAt: "2026-04-12T12:00:00.000Z",
		content: [
			{
				type: "plan-review",
				toolUseId: "tool-plan-1",
				toolName: "ExitPlanMode",
				plan: "1. Add a chat plan card.\n2. Keep the composer active.",
			},
		],
	};
}

describe("MemoConversationMessage plan review", () => {
	it("renders plan content as read-only text in the chat area", () => {
		render(
			<MemoConversationMessage
				message={createPlanReviewMessage()}
				sessionId="session-1"
				itemIndex={0}
			/>,
		);

		expect(screen.getByText(/1\. Add a chat plan card/)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Approve" }),
		).not.toBeInTheDocument();
	});

	it("renders multi-file edits as compact rows", () => {
		render(
			<AssistantToolCall
				toolName="apply_patch"
				args={{
					changes: [
						{
							path: "/src/index.test.tsx",
							kind: "modify",
							diff: "+added line",
						},
						{
							path: "/src/actions.tsx",
							kind: "modify",
							diff: "-removed line\n+added line",
						},
					],
				}}
			/>,
		);

		expect(
			screen.getByText("index.test.tsx").closest("[data-variant='row']"),
		).toBeInTheDocument();
		expect(
			screen.getByText("actions.tsx").closest("[data-variant='row']"),
		).toBeInTheDocument();
	});

	it("serializes assistant text parts without reasoning or tool output", () => {
		const message: ThreadMessageLike = {
			id: "assistant-copy-1",
			role: "assistant",
			createdAt: "2026-04-12T12:00:00.000Z",
			content: [
				{ type: "reasoning", text: "internal notes", streaming: false },
				{ type: "text", text: "Final answer line 1" },
				{
					type: "tool-call",
					toolCallId: "tool-1",
					toolName: "shell",
					args: { cmd: "date" },
					argsText: '{"cmd":"date"}',
					result: "Thu Apr 16",
				},
				{ type: "text", text: "Final answer line 2" },
			],
		};
		expect(serializeMessageForClipboard(message)).toBe(
			"Final answer line 1\n\nFinal answer line 2",
		);
	});

	it("serializes system content without timestamps", () => {
		const message: ThreadMessageLike = {
			id: "system-copy-1",
			role: "system",
			createdAt: "2026-04-12T12:00:00.000Z",
			content: [
				{
					type: "system-notice",
					severity: "warning",
					label: "Paused",
					body: "Waiting for input",
				},
				{ type: "prompt-suggestion", text: "Continue" },
			],
		};

		expect(serializeMessageForClipboard(message)).toBe(
			"Paused: Waiting for input\n\nContinue",
		);
	});

	it("copies the previous assistant message from the system meta row", () => {
		const assistantMessage: ThreadMessageLike = {
			id: "assistant-copy-source",
			role: "assistant",
			createdAt: "2026-04-12T11:59:00.000Z",
			content: [{ type: "text", text: "Real assistant reply" }],
		};
		const systemMessage: ThreadMessageLike = {
			id: "assistant-meta-row",
			role: "system",
			createdAt: "2026-04-12T12:00:00.000Z",
			content: [
				{
					type: "system-notice",
					severity: "warning",
					label: "aborted by user",
				},
			],
		};

		render(
			<MemoConversationMessage
				message={systemMessage}
				previousAssistantMessage={assistantMessage}
				sessionId="session-1"
				itemIndex={1}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

		expect(writeTextMock).toHaveBeenCalledWith("Real assistant reply");
	});
});
