import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallPart } from "@/lib/api";
import { SubAgentSpawnGroup, SubAgentToolCall } from "./subagent-tool";

// vitest doesn't run `globals: true`, so testing-library's auto-cleanup
// hook never fires. Without this, render output from one test leaks into
// the next and breaks `getByText` uniqueness checks.
afterEach(() => cleanup());

function spawn(
	id: string,
	nickname: string | null,
	role: string | null,
	prompt: string,
	streaming = false,
): ToolCallPart {
	const stateValue: Record<string, unknown> = { status: "pendingInit" };
	if (nickname !== null) stateValue.agentNickname = nickname;
	if (role !== null) stateValue.agentRole = role;
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: "subagent_spawn",
		args: {
			tool: "spawnAgent",
			status: streaming ? "inProgress" : "completed",
			senderThreadId: "thread_main",
			receiverThreadIds: nickname ? [`thread_${nickname.toLowerCase()}`] : [],
			prompt,
			agentsStates: nickname
				? { [`thread_${nickname.toLowerCase()}`]: stateValue }
				: {},
		},
		argsText: "",
		result: streaming ? null : "OK",
		// Real flow: accumulator sets `__streaming_status: "running"` when
		// the underlying Codex item.status === "inProgress". The synthetic
		// block reaches the frontend with streamingStatus === "running".
		streamingStatus: streaming ? "running" : undefined,
		children: undefined,
	};
}

describe("SubAgentSpawnGroup", () => {
	it("renders 'Created Hubble (explorer) with the instructions:' for a single spawn", () => {
		render(
			<SubAgentSpawnGroup
				parts={[spawn("call_1", "Hubble", "explorer", "Look at the frontend.")]}
			/>,
		);
		expect(screen.getByText("Created")).toBeInTheDocument();
		expect(screen.getByText("Hubble")).toBeInTheDocument();
		expect(screen.getByText("(explorer)")).toBeInTheDocument();
		expect(screen.getByText("with the instructions:")).toBeInTheDocument();
		expect(screen.getByText("Look at the frontend.")).toBeInTheDocument();
		// Single spawn: no "Spawned 1 agents" header.
		expect(screen.queryByText(/Spawned/)).not.toBeInTheDocument();
	});

	it("renders 'Spawned 2 agents' header + collapsed body for multiple spawns", () => {
		render(
			<SubAgentSpawnGroup
				parts={[
					spawn("call_1", "Hubble", "explorer", "Frontend pass."),
					spawn("call_2", "Dewey", "explorer", "Backend pass."),
				]}
			/>,
		);
		expect(screen.getByText("Spawned 2 agents")).toBeInTheDocument();
		// Default open when group is built (because at least one is in
		// progress... actually neither is here; default open for static
		// completed groups is `parts.length === 1`, so 2 → closed by default).
		// Trigger expand and verify both rows show.
		const trigger = screen.getByRole("button", { name: /Spawned 2 agents/ });
		fireEvent.click(trigger);
		expect(screen.getByText("Hubble")).toBeInTheDocument();
		expect(screen.getByText("Dewey")).toBeInTheDocument();
		expect(screen.getByText("Frontend pass.")).toBeInTheDocument();
		expect(screen.getByText("Backend pass.")).toBeInTheDocument();
	});

	it("falls back to the generic 'Sub-agent' label when no agentsStates entry exists", () => {
		render(
			<SubAgentSpawnGroup
				parts={[spawn("call_1", null, null, "Do the thing.")]}
			/>,
		);
		// `agentsStates` is empty when nickname is null (see helper) so the
		// row uses the generic "Sub-agent" placeholder — no threadId is
		// available to feed `getSubagentIdentity`.
		expect(screen.getByText("Sub-agent")).toBeInTheDocument();
		expect(screen.getByText("Do the thing.")).toBeInTheDocument();
	});

	it("assigns a pool nickname + color when threadId is known but nickname missing", () => {
		// Hand-construct a part with a populated agentsStates entry that has
		// no agentNickname — this is the "metadata fetch failed" case.
		const part: ToolCallPart = {
			type: "tool-call",
			toolCallId: "call_pool",
			toolName: "subagent_spawn",
			args: {
				tool: "spawnAgent",
				status: "completed",
				senderThreadId: "thread_main",
				receiverThreadIds: ["019df5f2-7a2e-7eb0-8137-2cd66efc68fb"],
				prompt: "Investigate.",
				agentsStates: {
					"019df5f2-7a2e-7eb0-8137-2cd66efc68fb": {
						status: "pendingInit",
						// no agentNickname / agentRole
					},
				},
			},
			argsText: "",
			result: "OK",
			children: undefined,
		};
		render(<SubAgentSpawnGroup parts={[part]} />);
		// We don't assert on the *specific* pool nickname (it's threadId-
		// hashed and that's an implementation detail), only that the UI does
		// NOT show the bare "Agent 7-...trailing-id" or generic "Sub-agent".
		expect(screen.queryByText("Sub-agent")).not.toBeInTheDocument();
		expect(screen.queryByText(/^Agent\s/)).not.toBeInTheDocument();
		// Whatever name we picked must be in the curated pool. We probe the
		// label span by walking from "Created" to its sibling.
		const created = screen.getByText("Created");
		const label = created.nextElementSibling as HTMLElement | null;
		expect(label).not.toBeNull();
		expect(label!.textContent?.trim().length).toBeGreaterThan(0);
		// Inline color must be set so the label gets a hue.
		expect(label!.getAttribute("style")).toMatch(/color:\s*var\(--subagent-/);
	});

	it("paints the bot icon and label with the same per-agent color across renders", () => {
		const partA: ToolCallPart = spawn(
			"call_1",
			"Newton",
			"explorer",
			"Pass A.",
		);
		const { unmount } = render(<SubAgentSpawnGroup parts={[partA]} />);
		const labelA = screen.getByText("Newton");
		const colorA = labelA.getAttribute("style") ?? "";
		expect(colorA).toMatch(/color:\s*var\(--subagent-/);
		unmount();

		// Same threadId (encoded into the spawn helper as `thread_newton`),
		// re-render → same color.
		render(<SubAgentSpawnGroup parts={[partA]} />);
		const labelA2 = screen.getByText("Newton");
		expect(labelA2.getAttribute("style")).toBe(colorA);
	});

	it("auto-opens while at least one spawn is still streaming", () => {
		render(
			<SubAgentSpawnGroup
				parts={[
					spawn("call_1", "Hubble", "explorer", "Pass A.", true),
					spawn("call_2", "Dewey", "explorer", "Pass B.", false),
				]}
			/>,
		);
		// Live spawn → group open by default → both bodies visible.
		expect(screen.getByText("Hubble")).toBeInTheDocument();
		expect(screen.getByText("Dewey")).toBeInTheDocument();
	});

	it("expands the prompt to a framed full-text box on click", () => {
		const longPrompt =
			"Line one of the prompt.\n" +
			"Line two has more detail.\n" +
			"Line three goes deeper.\n" +
			"Line four — well past line-clamp-2.";
		render(
			<SubAgentSpawnGroup
				parts={[spawn("call_1", "Hubble", "explorer", longPrompt)]}
			/>,
		);
		// Default: line-clamp preview present (full text in DOM, just clipped),
		// but no rounded box yet.
		const button = screen.getByRole("button", { name: /Created/ });
		expect(button).toBeInTheDocument();
		// The framed expanded box uses `whitespace-pre-wrap` — which we use as
		// a unique marker for the expanded state.
		const beforeExpand = document.querySelector("div.whitespace-pre-wrap");
		expect(beforeExpand).toBeNull();

		fireEvent.click(button);

		const afterExpand = document.querySelector("div.whitespace-pre-wrap");
		expect(afterExpand).not.toBeNull();
		expect(afterExpand?.textContent).toContain("Line four");

		// Click again collapses.
		fireEvent.click(button);
		expect(document.querySelector("div.whitespace-pre-wrap")).toBeNull();
	});
});

describe("SubAgentToolCall (wait)", () => {
	const waitPart: ToolCallPart = {
		type: "tool-call",
		toolCallId: "call_wait",
		toolName: "subagent_wait",
		args: {
			tool: "wait",
			status: "completed",
			senderThreadId: "thread_main",
			receiverThreadIds: ["thread_a", "thread_b"],
			agentsStates: {
				thread_a: {
					status: "completed",
					message: "TS files: 22, lines: 6409.",
					agentNickname: "Hubble",
					agentRole: "explorer",
				},
				thread_b: {
					status: "completed",
					message: "RS files: 53, lines: 13420.",
					agentNickname: "Dewey",
					agentRole: "explorer",
				},
			},
		},
		argsText: "",
		result: "...",
		children: undefined,
	};

	it("renders headline summary closed by default and reveals bodies on click", () => {
		render(<SubAgentToolCall part={waitPart} />);
		expect(
			screen.getByText("Collected 2 of 2 agent results"),
		).toBeInTheDocument();
		// Bodies hidden until expand.
		expect(screen.queryByText(/TS files/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Collected 2 of 2/ }));
		expect(screen.getByText(/TS files: 22/)).toBeInTheDocument();
		expect(screen.getByText(/RS files: 53/)).toBeInTheDocument();
	});

	it("shows in-progress state while wait is still running", () => {
		const inProgress: ToolCallPart = {
			...waitPart,
			args: { ...waitPart.args, status: "inProgress", agentsStates: {} },
		};
		render(<SubAgentToolCall part={inProgress} />);
		expect(screen.getByText(/Waiting on/)).toBeInTheDocument();
	});
});
