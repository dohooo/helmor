/**
 * Component-level tests for the subagent rendering path. Complement
 * two other layers of coverage:
 *   1. The Rust pipeline level (`pipeline_streams.rs`,
 *      `pipeline_fixtures.rs`, `pipeline_scenarios.rs`) — proves the
 *      backend produces the right `ThreadMessageLike` for each event.
 *   2. The structural-equality helper level
 *      (`workspace-panel-container.share.test.ts`) — proves the helper
 *      functions correctly identify "did the content change".
 *
 * Neither of those layers catches a bug where the helpers are correct
 * but a `React.memo` comparator forgets to call them on a particular
 * field — the memo bail-out path only runs at React render time, so
 * the only thing that reaches it is mounting the component and
 * checking what actually appears in the DOM after a re-render.
 *
 * The tests below all follow the same shape:
 *   render → assert initial DOM
 *   rerender with NEW props (simulates a pipeline `Full()` emit) →
 *   assert the DOM reflects the change
 *
 * If a memo comparator drops a field, the rerender's content silently
 * fails to update and the assertion fails.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtendedMessagePart, ToolCallPart } from "@/lib/api";
import { AssistantToolCall } from "./workspace-panel";

function bashCall(id: string, command: string): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: "Bash",
		args: { command },
		argsText: JSON.stringify({ command }),
	};
}

function readCall(id: string, file: string): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: "Read",
		args: { file_path: file },
		argsText: JSON.stringify({ file_path: file }),
	};
}

function taskArgs(description: string) {
	return {
		description,
		subagent_type: "Explore",
		prompt: "...",
	};
}

// Vitest doesn't auto-cleanup React Testing Library mounts (no
// `globals: true` in vite.config.ts), so without an explicit afterEach
// each test's DOM leaks into the next, causing spurious
// "found multiple elements" errors that look like memo bugs.
afterEach(cleanup);

describe("AssistantToolCall — Task subagent children rendering", () => {
	it("renders the tail preview row for the first child", () => {
		const { queryByText } = render(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[bashCall("call_1", "ls -la")]}
			/>,
		);
		expect(queryByText("ls -la")).toBeInTheDocument();
	});

	/**
	 * Simulates a pipeline `Full()` emit cycle: the parent assistant
	 * message is rebuilt with a NEW reference (so React re-runs the
	 * memo comparators), the Task tool's `toolName`/`args`/`result`
	 * are unchanged (so memo bail-out is tempting), but `childParts`
	 * has grown by one entry. Without `childrenStructurallyEqual` in
	 * the comparator, the rerender is skipped and the new child never
	 * appears in the DOM.
	 */
	it("re-renders when childParts grows across props updates", () => {
		const { rerender, queryByText } = render(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[bashCall("call_1", "ls -la")]}
			/>,
		);
		expect(queryByText("ls -la")).toBeInTheDocument();
		expect(queryByText("cat README.md")).not.toBeInTheDocument();

		rerender(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[
					bashCall("call_1", "ls -la"),
					bashCall("call_2", "cat README.md"),
				]}
			/>,
		);
		expect(queryByText("ls -la")).toBeInTheDocument();
		expect(queryByText("cat README.md")).toBeInTheDocument();
	});

	/**
	 * Same shape, different mutation: an existing child's content
	 * changes (e.g. a Bash tool finishes and its `result` is merged
	 * back, or in-place metadata mutates). The memo must invalidate
	 * for the rendered DOM to reflect the new content.
	 */
	it("re-renders when an existing child's content mutates", () => {
		const { rerender, queryByText } = render(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[bashCall("call_1", "ls -la")]}
			/>,
		);
		expect(queryByText("ls -la")).toBeInTheDocument();

		rerender(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[bashCall("call_1", "ls -la --color")]}
			/>,
		);
		expect(queryByText("ls -la --color")).toBeInTheDocument();
		expect(queryByText("ls -la", { exact: true })).not.toBeInTheDocument();
	});

	/**
	 * Tail-window slide. After 3 children are present, a 4th arrives
	 * and the visible window slides forward by one. The oldest child
	 * disappears from the preview, the newest one appears.
	 */
	it("slides the tail window forward when a 4th child arrives", () => {
		const initial: ExtendedMessagePart[] = [
			bashCall("call_1", "echo first"),
			bashCall("call_2", "echo second"),
			bashCall("call_3", "echo third"),
		];
		const { rerender, queryByText } = render(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={initial}
			/>,
		);
		expect(queryByText("echo first")).toBeInTheDocument();
		expect(queryByText("echo third")).toBeInTheDocument();

		rerender(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[...initial, bashCall("call_4", "echo fourth")]}
			/>,
		);
		expect(queryByText("echo first")).not.toBeInTheDocument();
		expect(queryByText("echo second")).toBeInTheDocument();
		expect(queryByText("echo third")).toBeInTheDocument();
		expect(queryByText("echo fourth")).toBeInTheDocument();
	});

	/**
	 * Different child types should also be re-rendered correctly when
	 * their content changes. Verifies the comparator doesn't accept a
	 * structurally-different list as "equal" just because the lengths
	 * happen to match.
	 */
	it("re-renders when childParts has the same length but different content", () => {
		const { rerender, queryByText } = render(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[
					bashCall("call_1", "echo a"),
					bashCall("call_2", "echo b"),
				]}
			/>,
		);
		expect(queryByText("echo a")).toBeInTheDocument();
		expect(queryByText("echo b")).toBeInTheDocument();

		// Same length, but call_2 is replaced with a Read of a file.
		// Read renders the file's basename ("hosts"), not the full path.
		rerender(
			<AssistantToolCall
				toolName="Task"
				args={taskArgs("Explore frontend")}
				childParts={[
					bashCall("call_1", "echo a"),
					readCall("call_2", "/etc/hosts"),
				]}
			/>,
		);
		expect(queryByText("echo a")).toBeInTheDocument();
		expect(queryByText("echo b")).not.toBeInTheDocument();
		expect(queryByText("hosts")).toBeInTheDocument();
	});
});

/**
 * The Rust pipeline (`adapter/mod.rs`) synthesizes a Task subagent's
 * initial instruction text as a `ToolCall` with `tool_name = "Prompt"`
 * and `args = {text: "..."}`. The frontend has to recognize that
 * synthetic name and surface it identically to other tool calls:
 * an icon, a one-line summary, and a click-to-expand panel that
 * shows the full instruction text.
 */
describe("AssistantToolCall — synthetic Prompt tool", () => {
	const longPrompt =
		"You are an Explore subagent. Your job is to scan the repository for unused files and report back what you find with file paths and reasoning.";

	it("renders the action label and an icon for tool_name=Prompt", () => {
		const { container, queryByText } = render(
			<AssistantToolCall
				toolName="Prompt"
				args={{ text: longPrompt }}
				childParts={[]}
			/>,
		);
		expect(queryByText("Prompt")).toBeInTheDocument();
		// The icon is a lucide SVG; assert at least one SVG renders so
		// the `getToolInfo` default branch (plain `<span>` placeholder)
		// can't sneak in for this tool name.
		expect(container.querySelector("svg")).not.toBeNull();
	});

	it("exposes the prompt text via the expandable details panel", () => {
		const { container, queryByText } = render(
			<AssistantToolCall
				toolName="Prompt"
				args={{ text: longPrompt }}
				childParts={[]}
			/>,
		);

		// Twist closed by default — text shouldn't render until expanded
		// to mirror the rest of the tool-call UX.
		const details = container.querySelector("details") as HTMLDetailsElement;
		expect(details).not.toBeNull();
		expect(details.open).toBe(false);
		expect(queryByText(longPrompt)).not.toBeInTheDocument();

		// JSDOM doesn't auto-fire `toggle` when you click a `<summary>`,
		// so set `open` directly and dispatch the native event the React
		// `onToggle` handler listens for. This mirrors what a real
		// browser does on click. (`fireEvent.toggle` doesn't exist in
		// the testing-library helper map; use a raw Event.)
		details.open = true;
		fireEvent(details, new Event("toggle", { bubbles: false }));
		expect(queryByText(longPrompt)).toBeInTheDocument();
	});
});
