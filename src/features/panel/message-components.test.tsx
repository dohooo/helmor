import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { MemoConversationMessage } from "./message-components";
import { serializeMessageForClipboard } from "./message-components/copy-message";
import { AssistantToolCall } from "./message-components/tool-call";

let writeTextMock: ReturnType<typeof vi.fn>;

afterEach(() => {
	cleanup();
	vi.useRealTimers();
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

	it("renders multi-file edits as compact rows when expanded", () => {
		const { container } = render(
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

		// Tool calls default to collapsed; expand before asserting on the body.
		const details = container.querySelector(
			"details",
		) as HTMLDetailsElement | null;
		expect(details).not.toBeNull();
		details!.open = true;
		fireEvent(details!, new Event("toggle"));

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
				{
					type: "reasoning",
					id: "assistant-copy-1:blk:0",
					text: "internal notes",
					streaming: false,
				},
				{
					type: "text",
					id: "assistant-copy-1:blk:1",
					text: "Final answer line 1",
				},
				{
					type: "tool-call",
					toolCallId: "tool-1",
					toolName: "shell",
					args: { cmd: "date" },
					argsText: '{"cmd":"date"}',
					result: "Thu Apr 16",
				},
				{
					type: "text",
					id: "assistant-copy-1:blk:3",
					text: "Final answer line 2",
				},
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
					id: "system-copy-1:notice",
					severity: "warning",
					label: "Paused",
					body: "Waiting for input",
				},
				{
					type: "prompt-suggestion",
					id: "system-copy-1:suggestion",
					text: "Continue",
				},
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
			content: [
				{
					type: "text",
					id: "assistant-copy-source:txt:0",
					text: "Real assistant reply",
				},
			],
		};
		const systemMessage: ThreadMessageLike = {
			id: "assistant-meta-row",
			role: "system",
			createdAt: "2026-04-12T12:00:00.000Z",
			content: [
				{
					type: "system-notice",
					id: "assistant-meta-row:notice",
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

	it("hides timestamps on Codex compact status notices", () => {
		vi.setSystemTime(new Date("2026-04-12T12:01:00.000Z"));
		const systemMessage: ThreadMessageLike = {
			id: "compact-start",
			role: "system",
			createdAt: "2026-04-12T12:00:00.000Z",
			content: [
				{
					type: "system-notice",
					id: "compact-start:notice",
					severity: "info",
					label: "Compacting context",
				},
			],
		};

		render(
			<MemoConversationMessage
				message={systemMessage}
				sessionId="session-1"
				itemIndex={1}
			/>,
		);

		expect(screen.getByText("Compacting context")).toBeInTheDocument();
		expect(screen.queryByText("1 minute ago")).not.toBeInTheDocument();
	});

	it("copies a user message from the bubble action slot", () => {
		const userMessage: ThreadMessageLike = {
			id: "user-copy-source",
			role: "user",
			createdAt: "2026-04-12T12:01:00.000Z",
			content: [
				{
					type: "text",
					id: "user-copy-source:text-0",
					text: "Ship the action slot.",
				},
			],
		};

		render(
			<MemoConversationMessage
				message={userMessage}
				sessionId="session-1"
				itemIndex={2}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

		expect(writeTextMock).toHaveBeenCalledWith("Ship the action slot.");
	});

	it("auto-collapses a completed reasoning block and shows elapsed time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

		const streamingMessage: ThreadMessageLike = {
			id: "assistant-reasoning-1",
			role: "assistant",
			createdAt: "2026-04-20T12:00:00.000Z",
			streaming: true,
			content: [
				{
					type: "reasoning",
					id: "assistant-reasoning-1:blk:0",
					text: "Inspecting the streamed reasoning block.",
					streaming: true,
				},
			],
		};

		const { rerender } = render(
			<MemoConversationMessage
				message={streamingMessage}
				sessionId="session-1"
				itemIndex={0}
			/>,
		);

		expect(screen.getByText("Thinking...")).toBeInTheDocument();
		expect(document.body).toHaveTextContent(
			"Inspecting the streamed reasoning block.",
		);

		act(() => {
			vi.advanceTimersByTime(2_000);
		});

		const completedMessage: ThreadMessageLike = {
			...streamingMessage,
			streaming: undefined,
			content: [
				{
					type: "reasoning",
					id: "assistant-reasoning-1:blk:0",
					text: "Inspecting the streamed reasoning block.",
					streaming: false,
				},
				{
					type: "text",
					id: "assistant-reasoning-1:blk:1",
					text: "Done.",
				},
			],
		};

		rerender(
			<MemoConversationMessage
				message={completedMessage}
				sessionId="session-1"
				itemIndex={0}
			/>,
		);

		expect(screen.getByText("Thought for 2s")).toBeInTheDocument();
		// Content is hidden because reasoning auto-collapses on completion
		// (CollapsibleContent unmounts via Radix Presence).
		expect(document.body).not.toHaveTextContent(
			"Inspecting the streamed reasoning block.",
		);
		expect(screen.getByText("Done.")).toBeInTheDocument();
	});

	it("shows duration for a fast reasoning block that mounts already completed", () => {
		// Fast thinking blocks (sub-frame) never reach the UI with
		// streaming=true — the first render the Reasoning component sees
		// already has the block in its completed state. The backend-
		// provided duration on the reasoning part still has to surface
		// as "Thought for Ns" instead of falling back to a generic
		// "Thinking" label that leaves the user with no signal the
		// reasoning finished.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

		const completedMessage: ThreadMessageLike = {
			id: "assistant-reasoning-fast",
			role: "assistant",
			createdAt: "2026-04-20T12:00:00.000Z",
			streaming: true,
			content: [
				{
					type: "reasoning",
					id: "assistant-reasoning-fast:blk:0",
					text: "Figured it out quickly.",
					streaming: false,
					durationMs: 3200,
				},
				{
					type: "text",
					id: "assistant-reasoning-fast:blk:1",
					text: "Answer.",
				},
			],
		};

		render(
			<MemoConversationMessage
				message={completedMessage}
				sessionId="session-1"
				itemIndex={0}
			/>,
		);

		expect(screen.getByText("Thought for 4s")).toBeInTheDocument();
		// `just-finished` blocks default closed now — matches what historical
		// reloads do, so a session that finishes thinking while the user is
		// switched to another workspace doesn't come back full of expanded
		// reasoning walls. The text is still in the DOM (CollapsibleContent
		// hides via attributes, not unmount), so query through the trigger's
		// state instead of looking for the body text.
		const trigger = screen.getByText("Thought for 4s").closest("button");
		expect(trigger?.getAttribute("data-state")).toBe("closed");
	});

	it("keeps a historical reasoning block collapsed without a duration", () => {
		const historicalMessage: ThreadMessageLike = {
			id: "assistant-reasoning-history",
			role: "assistant",
			createdAt: "2026-04-19T12:00:00.000Z",
			content: [
				{
					type: "reasoning",
					id: "assistant-reasoning-history:blk:0",
					text: "Old thinking content.",
				},
				{
					type: "text",
					id: "assistant-reasoning-history:blk:1",
					text: "Old answer.",
				},
			],
		};

		render(
			<MemoConversationMessage
				message={historicalMessage}
				sessionId="session-1"
				itemIndex={0}
			/>,
		);

		expect(screen.getByText("Thinking")).toBeInTheDocument();
		// Historical blocks default closed, so the body is not rendered.
		expect(screen.queryByText("Old thinking content.")).toBeNull();
	});
});

describe("ChatUserMessage with spaces in attachment paths", () => {
	it("renders a raw `@<path with spaces>` text segment verbatim", () => {
		const message: ThreadMessageLike = {
			id: "user-raw-1",
			role: "user",
			createdAt: "2026-04-29T08:24:35.000Z",
			content: [
				{
					type: "text",
					id: "user-raw-1:txt:0",
					text: "Clicking on pull @/Users/me/Library/Application Support/foo.jpg queues",
				},
			],
		};

		render(
			<MemoConversationMessage
				message={message}
				sessionId="session-1"
				itemIndex={0}
			/>,
		);

		// A whitespace-truncating regex would chip-render "Application".
		expect(screen.queryByText("Application")).toBeNull();
		expect(screen.getByText(/Clicking on pull/)).toBeInTheDocument();
	});

	it("renders an image badge with its full filename for an image-extension mention", () => {
		const path =
			"/Users/me/Library/Application Support/CleanShot/CleanShot 2026-04-29 at 08.24.35@2x.jpg";
		const message: ThreadMessageLike = {
			id: "user-image-1",
			role: "user",
			createdAt: "2026-04-29T08:24:35.000Z",
			content: [
				{ type: "text", id: "user-image-1:txt:0", text: "look " },
				{ type: "file-mention", id: "user-image-1:mention:0", path },
			],
		};

		render(
			<MemoConversationMessage
				message={message}
				sessionId="session-1"
				itemIndex={0}
			/>,
		);

		expect(
			screen.getAllByText(/CleanShot 2026-04-29 at 08\.24\.35@2x\.jpg/),
		).toHaveLength(1);
		expect(screen.queryByText(/Support\/CleanShot\/CleanShot/)).toBeNull();
	});
});
