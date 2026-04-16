import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { MemoConversationMessage } from "./message-components";
import { AssistantToolCall } from "./message-components/tool-call";

afterEach(() => {
	cleanup();
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
});
