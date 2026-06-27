import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentPart, WorkflowPart } from "@/lib/api";
import { SubagentStatusCard, WorkflowCard } from "./content-parts";

afterEach(cleanup);

function subagent(overrides: Partial<SubagentPart> = {}): SubagentPart {
	return {
		type: "subagent",
		id: "subagent:toolu_1:m1",
		status: "completed",
		title: "Inspect the repo",
		summary: "Inspected package.json and docs.",
		...overrides,
	};
}

describe("SubagentStatusCard", () => {
	it("renders the title, summary, and status word", () => {
		render(<SubagentStatusCard part={subagent()} />);
		expect(screen.getByText("Inspect the repo")).toBeInTheDocument();
		expect(
			screen.getByText("Inspected package.json and docs."),
		).toBeInTheDocument();
		expect(screen.getByText("done")).toBeInTheDocument();
	});

	it("shimmers the header only while running", () => {
		const { container: runningC } = render(
			<SubagentStatusCard
				part={subagent({ status: "running", summary: undefined })}
			/>,
		);
		expect(runningC.querySelector(".helmor-shimmer-text")).not.toBeNull();

		const { container: doneC } = render(
			<SubagentStatusCard part={subagent()} />,
		);
		expect(doneC.querySelector(".helmor-shimmer-text")).toBeNull();
	});

	it("labels a process-restart as interrupted, not failed", () => {
		render(
			<SubagentStatusCard
				part={subagent({
					status: "interrupted",
					summary: "the previous Claude Code process exited",
				})}
			/>,
		);
		expect(screen.getByText("interrupted")).toBeInTheDocument();
		expect(screen.queryByText("failed")).not.toBeInTheDocument();
	});

	it("falls back to a neutral label when no title is present", () => {
		render(
			<SubagentStatusCard
				part={subagent({ title: undefined, summary: undefined })}
			/>,
		);
		expect(screen.getByText("Sub-agent")).toBeInTheDocument();
	});
});

function workflow(overrides: Partial<WorkflowPart> = {}): WorkflowPart {
	return {
		type: "workflow",
		id: "workflow:wf_1",
		name: "demo-two-agents",
		status: "completed",
		agents: [
			{ label: "agent-alpha", status: "done", resultPreview: "alpha" },
			{ label: "agent-beta", status: "done", resultPreview: "beta" },
		],
		totalTokens: 61609,
		durationMs: 1655,
		...overrides,
	};
}

describe("WorkflowCard", () => {
	it("renders the workflow name, agents, result previews, and footer", () => {
		render(<WorkflowCard part={workflow()} />);
		expect(screen.getByText("Workflow · demo-two-agents")).toBeInTheDocument();
		expect(screen.getByText("agent-alpha")).toBeInTheDocument();
		expect(screen.getByText("agent-beta")).toBeInTheDocument();
		expect(screen.getByText("— alpha")).toBeInTheDocument();
		// Footer: agent count · tokens · duration.
		expect(screen.getByText(/2 agents/)).toBeInTheDocument();
		expect(screen.getByText(/61\.6k tokens/)).toBeInTheDocument();
		expect(screen.getByText(/1\.7s/)).toBeInTheDocument();
	});

	it("shimmers the header only while running, never on a settled run", () => {
		const { container: runningC } = render(
			<WorkflowCard part={workflow({ status: "running" })} />,
		);
		expect(runningC.querySelector(".helmor-shimmer-text")).not.toBeNull();

		const { container: doneC } = render(<WorkflowCard part={workflow()} />);
		// A completed run is a static label — no looping shimmer animation.
		expect(doneC.querySelector(".helmor-shimmer-text")).toBeNull();
	});

	it("shows the status word for the run", () => {
		render(<WorkflowCard part={workflow({ status: "failed", agents: [] })} />);
		expect(screen.getByText("failed")).toBeInTheDocument();
	});

	it("renders mixed agent states (done + running) in a running workflow", () => {
		const { container } = render(
			<WorkflowCard
				part={workflow({
					status: "running",
					agents: [
						{ label: "agent-alpha", status: "done", resultPreview: "alpha" },
						{ label: "agent-beta", status: "running" },
					],
				})}
			/>,
		);
		expect(screen.getByText("agent-alpha")).toBeInTheDocument();
		expect(screen.getByText("agent-beta")).toBeInTheDocument();
		// The running agent has no result preview yet.
		expect(screen.queryByText(/— beta/)).toBeNull();
		// Two distinct status icons rendered (done check + running dot).
		expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
	});

	it("omits missing footer fields without rendering 'undefined'", () => {
		render(<WorkflowCard part={workflow({ totalTokens: undefined })} />);
		// Footer shows agents + duration, but no token clause.
		expect(screen.getByText(/2 agents/)).toBeInTheDocument();
		expect(screen.queryByText(/tokens/)).toBeNull();
		expect(screen.queryByText(/undefined/)).toBeNull();
	});
});
