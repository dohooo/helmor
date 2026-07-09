import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamingStore } from "@/features/conversation/state/streaming-store";
import type { TaskState } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { shellEventName } from "@/shell/event-bus";
import { TaskProgressPanel } from "./index";

const SESSION_ID = "session-1";

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
	return {
		id: "task-1",
		description: "Count repo files",
		taskType: "subagent",
		subagentType: "general-purpose",
		status: "running",
		...overrides,
	};
}

function renderPanel(tasks: TaskState[]) {
	useStreamingStore.setState((state) => ({
		activeTasksBySession: {
			...state.activeTasksBySession,
			[SESSION_ID]: tasks,
		},
	}));
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	queryClient.setQueryData(
		[...helmorQueryKeys.sessionMessages(SESSION_ID), "thread"],
		[],
	);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return render(<TaskProgressPanel sessionId={SESSION_ID} />, { wrapper });
}

beforeEach(() => {
	cleanup();
	useStreamingStore.setState({ activeTasksBySession: {} });
});

describe("TaskProgressPanel", () => {
	it("shows the command and terminal output from the owning tool call", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages(SESSION_ID), "thread"],
			[
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "tc-1",
							toolName: "Bash",
							args: { command: "sleep 15 && echo done" },
							argsText: "",
							result: "done",
							taskState: makeTask({
								status: "completed",
								taskType: "local_bash",
								subagentType: undefined,
								description: "短命令:15秒后输出",
							}),
						},
					],
				},
			],
		);
		render(<TaskProgressPanel sessionId={SESSION_ID} />, {
			wrapper: ({ children }) => (
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			),
		});
		fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));
		fireEvent.click(screen.getByTestId("task-panel-status-completed"));
		expect(screen.getByText("sleep 15 && echo done")).toBeInTheDocument();
		expect(screen.getByText("done")).toBeInTheDocument();
	});

	it("renders nothing without tasks or fallbacks", () => {
		const { container } = renderPanel([]);
		expect(container).toBeEmptyDOMElement();
	});

	it("collapses by default showing current task, progress, and status", () => {
		renderPanel([makeTask()]);
		const strip = screen.getByRole("button", { name: "Background tasks" });
		expect(strip).toHaveTextContent("Count repo files");
		expect(strip).toHaveTextContent("0/1");
		expect(strip).toHaveTextContent("Running");
	});

	it("expands to the task list and collapses back", () => {
		renderPanel([makeTask({ status: "killed" })]);
		fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));
		expect(screen.getByTestId("task-panel-status-killed")).toHaveTextContent(
			"Killed",
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Collapse task panel" }),
		);
		expect(
			screen.getByRole("button", { name: "Background tasks" }),
		).toBeInTheDocument();
	});

	it("opens the detail level and publishes open-file-in-editor for the output file", () => {
		const listener = vi.fn();
		window.addEventListener(shellEventName("open-file-in-editor"), listener);
		renderPanel([
			makeTask({
				status: "completed",
				summary: "All done",
				outputFile: "/tmp/out.txt",
				usage: { totalTokens: 1200, toolUses: 2, durationMs: 4000 },
			}),
		]);
		fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));
		fireEvent.click(screen.getByTestId("task-panel-status-completed"));
		expect(screen.getByText("/tmp/out.txt")).toBeInTheDocument();
		fireEvent.click(screen.getByText("/tmp/out.txt"));
		expect(listener).toHaveBeenCalledTimes(1);
		window.removeEventListener(shellEventName("open-file-in-editor"), listener);
	});
});
