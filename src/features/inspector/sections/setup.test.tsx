import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import { renderWithProviders } from "@/test/render-with-providers";
import { TabsZoomContext } from "../layout";
import { _resetForTesting } from "../script-store";
import { SetupTab } from "./setup";

// ── Mocks ────────────────────────────────────────────────────────────────────

const apiMocks = vi.hoisted(() => ({
	executeRepoScript: vi.fn(),
	stopRepoScript: vi.fn(),
	writeRepoScriptStdin: vi.fn(),
	resizeRepoScript: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		executeRepoScript: apiMocks.executeRepoScript,
		stopRepoScript: apiMocks.stopRepoScript,
		writeRepoScriptStdin: apiMocks.writeRepoScriptStdin,
		resizeRepoScript: apiMocks.resizeRepoScript,
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
	workspaceId: "ws-1" as string | null,
	setupScript: "echo hello" as string | null,
	setupCompletedAt: null as string | null,
	isActive: true,
	onOpenSettings: vi.fn(),
};

// The floating Stop/Rerun button only renders while the tabs panel is
// hover-zoomed. Tests exercising that button wrap their tree with this
// provider to simulate the zoomed state; the empty/idle state tests leave
// it off to confirm the default-collapsed behavior.
function ZoomedProvider({ children }: { children: ReactNode }) {
	return (
		<TabsZoomContext.Provider
			value={{ isZoomPresented: true, isHoverExpanded: true }}
		>
			{children}
		</TabsZoomContext.Provider>
	);
}

function renderSetup(
	overrides: Partial<typeof defaults> = {},
	{ zoomed = false }: { zoomed?: boolean } = {},
) {
	const props = { ...defaults, ...overrides };
	const tree = (
		<Tabs defaultValue="setup">
			<SetupTab {...props} />
		</Tabs>
	);
	return renderWithProviders(
		zoomed ? <ZoomedProvider>{tree}</ZoomedProvider> : tree,
	);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SetupTab", () => {
	beforeEach(() => {
		apiMocks.executeRepoScript.mockReset().mockResolvedValue(undefined);
		apiMocks.stopRepoScript.mockReset().mockResolvedValue(true);
		apiMocks.writeRepoScriptStdin.mockReset().mockResolvedValue(true);
		apiMocks.resizeRepoScript.mockReset().mockResolvedValue(true);
	});

	afterEach(() => {
		_resetForTesting();
		vi.restoreAllMocks();
		cleanup();
	});

	// ── Empty / idle states ────────────────────────────────────────────────

	it("shows empty state when no script is configured", () => {
		renderSetup({ setupScript: null });

		expect(screen.getByText("No setup script configured")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /open settings/i }),
		).toBeInTheDocument();
	});

	it("shows 'Run setup' when script exists but hasn't run yet", () => {
		renderSetup();

		expect(
			screen.getByRole("button", { name: /run setup/i }),
		).toBeInTheDocument();
	});

	// ── Manual run / stop / rerun ──────────────────────────────────────────

	it("clicking 'Run setup' calls executeRepoScript", async () => {
		const user = userEvent.setup();
		renderSetup();

		await user.click(screen.getByRole("button", { name: /run setup/i }));

		expect(apiMocks.executeRepoScript).toHaveBeenCalledWith(
			"repo-1",
			"setup",
			expect.any(Function),
			"ws-1",
		);
	});

	it("shows Stop button while running (when zoomed)", async () => {
		const user = userEvent.setup();
		renderSetup({}, { zoomed: true });

		await user.click(screen.getByRole("button", { name: /run setup/i }));

		expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
	});

	it("Stop button calls stopRepoScript with workspace id", async () => {
		const user = userEvent.setup();
		renderSetup({}, { zoomed: true });

		await user.click(screen.getByRole("button", { name: /run setup/i }));
		await user.click(screen.getByRole("button", { name: /stop/i }));

		expect(apiMocks.stopRepoScript).toHaveBeenCalledWith(
			"repo-1",
			"setup",
			"ws-1",
		);
	});

	it("shows 'Rerun setup' button after script exits (when zoomed)", async () => {
		const user = userEvent.setup();

		let onEvent: (e: unknown) => void = () => {};
		apiMocks.executeRepoScript.mockImplementation(
			(_r: string, _t: string, cb: (e: unknown) => void) => {
				onEvent = cb;
				return Promise.resolve();
			},
		);

		renderSetup({}, { zoomed: true });
		await user.click(screen.getByRole("button", { name: /run setup/i }));

		// Simulate the exited event from the backend.
		onEvent({ type: "exited", code: 0 });

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /rerun setup/i }),
			).toBeInTheDocument();
		});
	});

	it("hides the floating Stop button until the panel is zoomed", async () => {
		const user = userEvent.setup();
		renderSetup();

		await user.click(screen.getByRole("button", { name: /run setup/i }));

		// Terminal should be mounted (script has run), but the corner Stop
		// button stays out of the DOM while the panel is at its resting size.
		expect(screen.getByTestId("terminal")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /stop/i }),
		).not.toBeInTheDocument();
	});
});
