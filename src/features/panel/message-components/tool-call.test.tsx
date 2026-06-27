import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantToolCall } from "./tool-call";

// Without cleanup the DOM accumulates and cross-test text collides.
afterEach(cleanup);

describe("AssistantToolCall apply_patch", () => {
	it("defaults multi-file edits to collapsed and suppresses generic patch text when expanded", () => {
		const { container } = render(
			<AssistantToolCall
				toolName="apply_patch"
				args={{
					changes: [
						{ path: "/src/request-parser.ts", diff: "+line one" },
						{ path: "/src/data_dir.rs", diff: "+line two" },
						{ path: "/src/App.tsx", diff: "+line three" },
					],
				}}
				result="Patch applied"
			/>,
		);

		// Default: collapsed.
		expect(screen.queryByText("request-parser.ts")).not.toBeInTheDocument();
		expect(screen.queryByText("data_dir.rs")).not.toBeInTheDocument();
		expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();

		const details = container.querySelector(
			"details",
		) as HTMLDetailsElement | null;
		expect(details).not.toBeNull();

		// Expand: file list appears, generic "Patch applied" stays suppressed.
		details!.open = true;
		fireEvent(details!, new Event("toggle"));

		expect(screen.queryByText("Patch applied")).not.toBeInTheDocument();
		expect(screen.getByText("request-parser.ts")).toBeInTheDocument();
		expect(screen.getByText("data_dir.rs")).toBeInTheDocument();
		expect(screen.getByText("App.tsx")).toBeInTheDocument();

		// Collapse again: file list disappears.
		details!.open = false;
		fireEvent(details!, new Event("toggle"));

		expect(screen.queryByText("request-parser.ts")).not.toBeInTheDocument();
		expect(screen.queryByText("data_dir.rs")).not.toBeInTheDocument();
		expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
	});
});

describe("AssistantToolCall default-collapsed", () => {
	it("keeps a streaming Read collapsed until the user opens it", () => {
		const { container } = render(
			<AssistantToolCall
				toolName="Read"
				args={{ file_path: "/src/App.tsx" }}
				streamingStatus="in_progress"
			/>,
		);

		const details = container.querySelector("details");
		expect(details).not.toBeNull();
		expect(details!.open).toBe(false);
	});

	it("keeps a finished Bash with output collapsed by default", () => {
		const { container } = render(
			<AssistantToolCall
				toolName="Bash"
				args={{ command: "ls -la" }}
				result={"total 8\ndrwxr-xr-x  3 user staff   96 Jan  1 00:00 .\n"}
			/>,
		);

		const details = container.querySelector("details");
		expect(details).not.toBeNull();
		expect(details!.open).toBe(false);
		// Output content should not be rendered until the user opens the details.
		expect(screen.queryByText(/drwxr-xr-x/)).not.toBeInTheDocument();
	});
});

// opencode tools arrive pre-normalized by the Rust adapter; no opencode branch here.
describe("AssistantToolCall normalized provider tools", () => {
	it("renders a normalized Bash tool (universal shape) with description + command", () => {
		render(
			<AssistantToolCall
				toolName="Bash"
				args={{
					command: "git ls-files --cached | sort",
					description: "Find tracked files",
				}}
				result="a.ts\nb.ts"
			/>,
		);
		expect(screen.getByText("Find tracked files")).toBeInTheDocument();
		expect(
			screen.getByText("git ls-files --cached | sort"),
		).toBeInTheDocument();
	});
});

describe("AssistantToolCall sub-agent collapsible block", () => {
	it("keeps sub-agent work collapsed by default so the thread doesn't jump", () => {
		// A running Agent streaming nested work. The body stays collapsed so only
		// the stable single-line summary shows — the surrounding thread can't
		// shift as the sub-agent's content changes height.
		const { container } = render(
			<AssistantToolCall
				toolName="Agent"
				args={{ description: "Investigate" }}
				childParts={[
					{ type: "text", id: "t0", text: "Looking into the repo..." },
				]}
			/>,
		);
		// Summary (description) is visible; nested content is not.
		expect(screen.getByText("Investigate")).toBeInTheDocument();
		expect(
			screen.queryByText("Looking into the repo..."),
		).not.toBeInTheDocument();
		const details = container.querySelector("details");
		expect(details).not.toBeNull();
		expect(details!.open).toBe(false);
	});

	it("reveals the nested sub-agent work once expanded", () => {
		const { container } = render(
			<AssistantToolCall
				toolName="Agent"
				args={{ description: "Investigate" }}
				childParts={[
					{ type: "text", id: "t0", text: "Looking into the repo." },
				]}
			/>,
		);
		const details = container.querySelector("details") as HTMLDetailsElement;
		details.open = true;
		fireEvent(details, new Event("toggle"));
		expect(screen.getByText("Looking into the repo.")).toBeInTheDocument();
	});
});

describe("AssistantToolCall backgrounded sub-agent launch", () => {
	const LAUNCH_ACK =
		"Async agent launched successfully.\nagentId: af0b09c774b3336ce (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.\noutput_file: /tmp/x/tasks/af0b09c774b3336ce.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript.";

	it("never renders the raw launch acknowledgment, shows running instead", () => {
		render(
			<AssistantToolCall
				toolName="Task"
				args={{ description: "Research OpenAI latest news" }}
				result={LAUNCH_ACK}
			/>,
		);
		// The internal plumbing text must not leak into the chat.
		expect(screen.queryByText(/Async agent launched/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Do NOT Read/)).not.toBeInTheDocument();
		expect(screen.queryByText(/output_file/)).not.toBeInTheDocument();
		// The agent reads as running in the background instead.
		expect(screen.getByText("Research OpenAI latest news")).toBeInTheDocument();
		expect(screen.getByText("running in background")).toBeInTheDocument();
	});

	it("reveals streamed children when expanded, still no raw ack", () => {
		const { container } = render(
			<AssistantToolCall
				toolName="Task"
				args={{ description: "Research SpaceX latest news" }}
				result={LAUNCH_ACK}
				childParts={[
					{
						type: "subagent",
						id: "subagent:toolu_1:m1",
						status: "running",
						title: "Research SpaceX latest news",
						summary: "Searching the web",
					},
				]}
			/>,
		);
		expect(screen.queryByText(/Async agent launched/)).not.toBeInTheDocument();
		// Nested status is collapsed until the user expands the block.
		expect(screen.queryByText("Searching the web")).not.toBeInTheDocument();
		const details = container.querySelector("details") as HTMLDetailsElement;
		details.open = true;
		fireEvent(details, new Event("toggle"));
		expect(screen.getByText("Searching the web")).toBeInTheDocument();
		// The raw ack stays suppressed even when expanded.
		expect(screen.queryByText(/Async agent launched/)).not.toBeInTheDocument();
	});
});
