import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import { renderWithProviders } from "@/test/render-with-providers";
import { RunTab } from "./run";

// ── Mocks ────────────────────────────────────────────────────────────────────

const apiMocks = vi.hoisted(() => ({
	executeRepoScript: vi.fn(),
	stopRepoScript: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		executeRepoScript: apiMocks.executeRepoScript,
		stopRepoScript: apiMocks.stopRepoScript,
	};
});

vi.mock("@/components/terminal-output", () => ({
	TerminalOutput: ({ className }: { className?: string }) => (
		<div data-testid="terminal" className={className} />
	),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const defaults = {
	repoId: "repo-1",
	workspaceId: "ws-1",
	runScript: "npm test" as string | null,
	isActive: true,
	onOpenSettings: vi.fn(),
};

function renderRun(overrides: Partial<typeof defaults> = {}) {
	const props = { ...defaults, ...overrides };
	return renderWithProviders(
		<Tabs defaultValue="run">
			<RunTab {...props} />
		</Tabs>,
	);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RunTab", () => {
	beforeEach(() => {
		apiMocks.executeRepoScript.mockReset().mockResolvedValue(undefined);
		apiMocks.stopRepoScript.mockReset().mockResolvedValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		cleanup();
	});

	// ── Empty / idle states ────────────────────────────────────────────────

	it("shows empty state when no script is configured", () => {
		renderRun({ runScript: null });

		expect(
			screen.getByRole("button", { name: /add run script/i }),
		).toBeInTheDocument();
	});

	it("shows 'Run' button when script exists but hasn't run yet", () => {
		renderRun();

		expect(screen.getByRole("button", { name: /^run$/i })).toBeInTheDocument();
	});

	// ── Run / stop / rerun ─────────────────────────────────────────────────

	it("clicking 'Run' calls executeRepoScript with workspace id", async () => {
		const user = userEvent.setup();
		renderRun();

		await user.click(screen.getByRole("button", { name: /^run$/i }));

		expect(apiMocks.executeRepoScript).toHaveBeenCalledWith(
			"repo-1",
			"run",
			expect.any(Function),
			"ws-1",
		);
	});

	it("shows Stop button while running", async () => {
		const user = userEvent.setup();
		renderRun();

		await user.click(screen.getByRole("button", { name: /^run$/i }));

		expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
	});

	it("Stop button calls stopRepoScript with workspace id", async () => {
		const user = userEvent.setup();
		renderRun();

		await user.click(screen.getByRole("button", { name: /^run$/i }));
		await user.click(screen.getByRole("button", { name: /stop/i }));

		expect(apiMocks.stopRepoScript).toHaveBeenCalledWith(
			"repo-1",
			"run",
			"ws-1",
		);
	});

	it("shows 'Rerun' button after script exits", async () => {
		const user = userEvent.setup();

		let onEvent: (e: unknown) => void = () => {};
		apiMocks.executeRepoScript.mockImplementation(
			(_r: string, _t: string, cb: (e: unknown) => void) => {
				onEvent = cb;
				return Promise.resolve();
			},
		);

		renderRun();
		await user.click(screen.getByRole("button", { name: /^run$/i }));

		onEvent({ type: "exited", code: 0 });

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /rerun/i }),
			).toBeInTheDocument();
		});
	});

	it("does not show any floating button when idle and not yet run", () => {
		renderRun();

		expect(
			screen.queryByRole("button", { name: /stop/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /rerun/i }),
		).not.toBeInTheDocument();
	});
});
