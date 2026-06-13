import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionContextCandidate } from "@/features/panel/session-context";
import { SessionContextInjector } from "./session-context-injector";

vi.mock("@/components/icons", () => ({
	ClaudeIcon: (props: { className?: string }) => (
		<span data-testid="claude-icon" {...props} />
	),
	CursorIcon: (props: { className?: string }) => (
		<span data-testid="cursor-icon" {...props} />
	),
	OpenAIIcon: (props: { className?: string }) => (
		<span data-testid="codex-icon" {...props} />
	),
	OpenCodeIcon: (props: { className?: string }) => (
		<span data-testid="opencode-icon" {...props} />
	),
}));

function candidate(
	overrides: Partial<SessionContextCandidate> &
		Pick<SessionContextCandidate, "id">,
): SessionContextCandidate {
	const { id, ...rest } = overrides;
	return {
		id,
		workspaceId: "workspace-1",
		title: id,
		agentType: "claude",
		status: "idle",
		createdAt: "2026-04-10T00:00:00Z",
		updatedAt: "2026-04-10T00:00:00Z",
		lastUserMessageAt: "2026-04-10T00:00:00Z",
		displayProvider: "claude",
		...rest,
	};
}

describe("SessionContextInjector", () => {
	it("renders selectable session chips with provider icons", async () => {
		const user = userEvent.setup();
		const onToggleSession = vi.fn();

		render(
			<SessionContextInjector
				candidates={[
					candidate({
						id: "session-1",
						title: "Plan cache fix",
						displayProvider: "codex",
					}),
				]}
				selectedSessionIds={["session-1"]}
				onToggleSession={onToggleSession}
			/>,
		);

		expect(screen.getByText("Inject sessions:")).toBeInTheDocument();
		expect(screen.getByTestId("codex-icon")).toBeInTheDocument();

		const chip = screen.getByRole("button", { name: /Plan cache fix/ });
		expect(chip).toHaveAttribute("aria-pressed", "true");

		await user.click(chip);

		expect(onToggleSession).toHaveBeenCalledWith("session-1");
	});
});
