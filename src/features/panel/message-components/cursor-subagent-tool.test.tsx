import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallPart } from "@/lib/api";
import {
	CursorSubagentToolCall,
	isCursorSubagentToolName,
} from "./cursor-subagent-tool";

afterEach(() => cleanup());

function part(overrides: Partial<ToolCallPart> = {}): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: "tool_xyz",
		toolName: "cursor_task",
		args: {
			agentId: "agent-abc",
			subagentType: "code-reviewer",
			description: "Review the auth flow for security issues",
			prompt: "Look at the OAuth handlers in /auth/. Flag any token leaks.",
			model: "composer-2",
			mode: "auto",
		},
		argsText: "",
		result: "Found 0 critical issues. 2 minor suggestions inline.",
		streamingStatus: "done",
		...overrides,
	};
}

describe("isCursorSubagentToolName", () => {
	it("matches `cursor_task`", () => {
		expect(isCursorSubagentToolName("cursor_task")).toBe(true);
	});
	it("does not match `task` (claude/cursor-raw)", () => {
		expect(isCursorSubagentToolName("task")).toBe(false);
	});
	it("does not match codex `subagent_spawn`", () => {
		expect(isCursorSubagentToolName("subagent_spawn")).toBe(false);
	});
});

describe("CursorSubagentToolCall", () => {
	it("renders subagent type, mode, description, and model chip", () => {
		render(<CursorSubagentToolCall part={part()} />);
		expect(screen.getByText("code-reviewer")).toBeInTheDocument();
		expect(screen.getByText("· auto")).toBeInTheDocument();
		expect(
			screen.getByText("Review the auth flow for security issues"),
		).toBeInTheDocument();
		expect(screen.getByText("composer-2")).toBeInTheDocument();
	});

	it("collapses prompt + result by default; expands on click", () => {
		render(<CursorSubagentToolCall part={part()} />);
		// Body content should not be visible initially.
		expect(screen.queryByText("Prompt")).not.toBeInTheDocument();
		expect(screen.queryByText("Result")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("Prompt")).toBeInTheDocument();
		expect(screen.getByText("Result")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Look at the OAuth handlers in /auth/. Flag any token leaks.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Found 0 critical issues. 2 minor suggestions inline."),
		).toBeInTheDocument();
	});

	it("shows `Waiting for subagent…` when result is missing and status is running", () => {
		render(
			<CursorSubagentToolCall
				part={part({ result: undefined, streamingStatus: "running" })}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("Waiting for subagent…")).toBeInTheDocument();
	});

	it("shows fallback action when subagentType is missing", () => {
		render(
			<CursorSubagentToolCall
				part={part({
					args: {
						agentId: "agent-abc",
						prompt: "do thing",
						model: "composer-2",
						mode: "auto",
					},
				})}
			/>,
		);
		expect(screen.getByText("Sub-agent")).toBeInTheDocument();
	});

	it("does not render expand button when neither prompt nor result is set", () => {
		render(
			<CursorSubagentToolCall
				part={part({
					args: {
						agentId: "agent-abc",
						subagentType: "code-reviewer",
						model: "composer-2",
						mode: "auto",
					},
					result: undefined,
				})}
			/>,
		);
		const button = screen.getByRole("button");
		expect(button).toBeDisabled();
	});

	it("extracts result.value when result is wrapped in {status, value}", () => {
		render(
			<CursorSubagentToolCall
				part={part({
					result: { status: "success", value: "Wrapped value content" },
				})}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("Wrapped value content")).toBeInTheDocument();
	});
});
