/**
 * Component tests for the Codex goal banner. Pairs with the Rust
 * `codex_goal::tests` (which prove the DB layer narrates transitions
 * correctly) and the sidecar `parseGoalCommand` tests (which prove the
 * `/goal` flavors parse). What these specifically guard:
 *
 *   - The banner hides when there's no goal (mount overhead is
 *     cheap, but rendering the chrome shouldn't happen for sessions
 *     without a goal — most sessions).
 *   - Clear button fires `mutateCodexGoal(sessionId, "clear")`.
 *   - Paused state shows the Resume button + clicking it fires the
 *     host-supplied `onResume` callback.
 *   - Active state hides the Resume button.
 *
 * The mutate call is mocked via `vi.mock("@/lib/api", ...)` so the
 * tests don't need a Tauri runtime.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexGoalState } from "@/lib/api";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";

const apiMockState = vi.hoisted(() => ({
	mutateCodexGoal: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		mutateCodexGoal: apiMockState.mutateCodexGoal,
	};
});

import { CodexGoalBanner } from "./codex-goal-banner";

function activeGoal(): CodexGoalState {
	return {
		threadId: "t1",
		objective: "improve test coverage",
		status: "active",
		tokenBudget: null,
		tokensUsed: 1234,
		timeUsedSeconds: 60,
		createdAt: 0,
		updatedAt: 0,
	};
}

function pausedGoal(): CodexGoalState {
	return { ...activeGoal(), status: "paused" };
}

function renderWithGoal(goal: CodexGoalState | null, onResume?: () => void) {
	const queryClient = createHelmorQueryClient();
	queryClient.setQueryData(helmorQueryKeys.sessionCodexGoal("session-1"), goal);
	return render(
		<QueryClientProvider client={queryClient}>
			<CodexGoalBanner sessionId="session-1" onResume={onResume} />
		</QueryClientProvider>,
	);
}

describe("CodexGoalBanner", () => {
	beforeEach(() => {
		apiMockState.mutateCodexGoal.mockReset();
		apiMockState.mutateCodexGoal.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
	});

	it("renders nothing when no goal is set", () => {
		const { container } = renderWithGoal(null);
		// Goal-less sessions (Claude, fresh codex sessions, cleared goals)
		// must not paint the floating header.
		expect(
			container.querySelector("[data-testid='codex-goal-banner']"),
		).toBeNull();
	});

	it("renders objective + status + tokens when an active goal exists", async () => {
		renderWithGoal(activeGoal());

		await waitFor(() => {
			expect(screen.getByTestId("codex-goal-banner")).toBeInTheDocument();
		});
		expect(screen.getByText("improve test coverage")).toBeInTheDocument();
		expect(screen.getByText("active")).toBeInTheDocument();
		// tokens render as "Used: 1.2K" via formatTokens.
		expect(screen.getByText(/Used:/)).toBeInTheDocument();
	});

	it("Clear button fires mutateCodexGoal with action=clear", async () => {
		renderWithGoal(activeGoal());

		await waitFor(() => {
			expect(screen.getByTestId("codex-goal-banner")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole("button", { name: /clear goal/i }));

		// useMutation dispatches async — wait one tick for the mutation
		// queue to flush before asserting.
		await waitFor(() =>
			expect(apiMockState.mutateCodexGoal).toHaveBeenCalledTimes(1),
		);
		expect(apiMockState.mutateCodexGoal).toHaveBeenCalledWith(
			"session-1",
			"clear",
		);
	});

	it("hides the Resume button when goal is active", async () => {
		renderWithGoal(activeGoal(), vi.fn());

		await waitFor(() => {
			expect(screen.getByTestId("codex-goal-banner")).toBeInTheDocument();
		});
		expect(screen.queryByRole("button", { name: /resume goal/i })).toBeNull();
	});

	it("shows Resume button when goal is paused and onResume is provided", async () => {
		const onResume = vi.fn();
		renderWithGoal(pausedGoal(), onResume);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /resume goal/i }),
			).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole("button", { name: /resume goal/i }));

		expect(onResume).toHaveBeenCalledTimes(1);
		// Crucially: Resume is NOT routed through mutateCodexGoal — it
		// goes via the host's onResume callback so the resulting send-
		// Message stream subscription catches the goal-continuation turn
		// codex auto-spawns.
		expect(apiMockState.mutateCodexGoal).not.toHaveBeenCalled();
	});

	it("hides the Resume button when paused but no onResume is provided", async () => {
		renderWithGoal(pausedGoal()); // no onResume

		await waitFor(() => {
			expect(screen.getByTestId("codex-goal-banner")).toBeInTheDocument();
		});
		expect(screen.queryByRole("button", { name: /resume goal/i })).toBeNull();
	});
});
