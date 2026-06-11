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

describe("AssistantToolCall sub-agent live tail", () => {
	it("shows a streaming sub-agent's trailing text inside the collapsed card", () => {
		// A running Agent (result == null) whose only child is the text it is
		// currently streaming. The collapsed preview must surface it so the
		// live tokens don't vanish into the card.
		render(
			<AssistantToolCall
				toolName="Agent"
				args={{ description: "Investigate" }}
				childParts={[
					{ type: "text", id: "t0", text: "Looking into the repo..." },
				]}
			/>,
		);
		expect(screen.getByText("Looking into the repo...")).toBeInTheDocument();
	});

	it("keeps a finished sub-agent's text collapsed until expanded", () => {
		// Same shape but finalized (result set) — the trailing text stays
		// hidden in the collapsed preview, matching existing behavior.
		render(
			<AssistantToolCall
				toolName="Agent"
				args={{ description: "Investigate" }}
				result="done"
				childParts={[
					{ type: "text", id: "t0", text: "Looking into the repo." },
				]}
			/>,
		);
		expect(
			screen.queryByText("Looking into the repo."),
		).not.toBeInTheDocument();
	});
});
