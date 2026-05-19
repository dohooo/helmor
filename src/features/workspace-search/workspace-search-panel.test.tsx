import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSearchResult } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	searchWorkspace: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		searchWorkspace: apiMocks.searchWorkspace,
	};
});

import { WorkspaceSearchPanel } from "./workspace-search-panel";

const SAMPLE_RESULT: WorkspaceSearchResult = {
	matches: [
		{
			relativePath: "src/main.rs",
			lineNumber: 17,
			line: "fn main() {",
		},
		{
			relativePath: "src/lib.rs",
			lineNumber: 4,
			line: "use anyhow::Result;",
		},
		{
			relativePath: "tests/integration.rs",
			lineNumber: 42,
			line: "    let main_fn = ();",
		},
	],
	truncated: false,
};

type RenderOverrides = {
	isOpen?: boolean;
	onClose?: () => void;
	workspaceDir?: string | null;
	workspaceId?: string | null;
	runtimeName?: string | null;
	onOpenResult?: (path: string, line: number) => void;
};

function renderPanel(overrides: RenderOverrides = {}) {
	const onClose = overrides.onClose ?? vi.fn();
	const onOpenResult = overrides.onOpenResult ?? vi.fn();
	// `??` collapses `null` to the right side, so for nullable props
	// we check key presence explicitly. Lets tests assert the
	// no-workspace path without monkey-patching.
	const workspaceDir =
		"workspaceDir" in overrides ? (overrides.workspaceDir ?? null) : "/repo";
	const workspaceId =
		"workspaceId" in overrides ? (overrides.workspaceId ?? null) : "ws-1";
	const runtimeName =
		"runtimeName" in overrides ? (overrides.runtimeName ?? null) : null;
	const rendered = renderWithProviders(
		<WorkspaceSearchPanel
			isOpen={overrides.isOpen ?? true}
			onClose={onClose}
			workspaceDir={workspaceDir}
			workspaceId={workspaceId}
			runtimeName={runtimeName}
			onOpenResult={onOpenResult}
		/>,
	);
	return { ...rendered, onClose, onOpenResult };
}

describe("WorkspaceSearchPanel", () => {
	beforeEach(() => {
		apiMocks.searchWorkspace.mockReset();
		apiMocks.searchWorkspace.mockResolvedValue(SAMPLE_RESULT);
		// Real timers by default; tests that need to flush the debounce
		// switch to fake timers explicitly.
		vi.useRealTimers();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("does not render when isOpen is false", () => {
		renderPanel({ isOpen: false });
		expect(screen.queryByTestId("workspace-search-panel")).toBeNull();
	});

	it("renders the dialog with an autofocused input when open", async () => {
		renderPanel();
		const panel = await screen.findByTestId("workspace-search-panel");
		expect(panel).toBeInTheDocument();
		// Input gets focused on next tick — wait for it.
		const input = await screen.findByPlaceholderText(/search files/i);
		await waitFor(() => expect(input).toHaveFocus());
	});

	it("shows the initial info status when no query is typed yet", async () => {
		renderPanel();
		const status = await screen.findByTestId("workspace-search-status");
		expect(status.textContent).toMatch(/Type to search/i);
		expect(apiMocks.searchWorkspace).not.toHaveBeenCalled();
	});

	it("shows the 'open a workspace' hint when workspaceDir is null", async () => {
		renderPanel({ workspaceDir: null });
		const status = await screen.findByTestId("workspace-search-status");
		expect(status.textContent).toMatch(/Open a workspace/i);
	});

	it("debounces typing then dispatches the search and renders results", async () => {
		const user = userEvent.setup();
		renderPanel();
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "main");

		// First call may fire only after the debounce settles; allow up
		// to 1s for the fetch to flush. We assert the call shape +
		// rendered results, not the exact tick count.
		await waitFor(
			() => {
				expect(apiMocks.searchWorkspace).toHaveBeenCalled();
			},
			{ timeout: 1000 },
		);
		const call = apiMocks.searchWorkspace.mock.calls.at(-1)?.[0];
		expect(call.query).toBe("main");
		expect(call.workspaceDir).toBe("/repo");
		expect(call.workspaceId).toBe("ws-1");

		// All three sample results render.
		expect(
			await screen.findByTestId("workspace-search-result-src/main.rs-17"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("workspace-search-result-src/lib.rs-4"),
		).toBeInTheDocument();
	});

	it("forwards case-insensitive and fixed-string flags to the API", async () => {
		const user = userEvent.setup();
		renderPanel();
		// Toggle fixed-string ON (default OFF = regex). The regex toggle
		// button is aria-pressed=true for !fixedString, so a click flips
		// fixedString true.
		const regexToggle = screen.getByRole("button", {
			name: /Switch to fixed-string matching/,
		});
		await user.click(regexToggle);
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "foo");
		await waitFor(() => expect(apiMocks.searchWorkspace).toHaveBeenCalled(), {
			timeout: 1000,
		});
		const call = apiMocks.searchWorkspace.mock.calls.at(-1)?.[0];
		expect(call.fixedString).toBe(true);
		// Default case-insensitive is true; we didn't toggle it.
		expect(call.caseInsensitive).toBe(true);
	});

	it("does NOT dispatch a search when workspaceDir is null", async () => {
		const user = userEvent.setup();
		renderPanel({ workspaceDir: null });
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "anything");
		// Wait through the debounce window — no fetch should fire because
		// queryEnabled requires workspaceDir.
		await new Promise((r) => setTimeout(r, 350));
		expect(apiMocks.searchWorkspace).not.toHaveBeenCalled();
	});

	it("renders the truncated chip when the server caps the response", async () => {
		apiMocks.searchWorkspace.mockResolvedValue({
			matches: SAMPLE_RESULT.matches,
			truncated: true,
		});
		const user = userEvent.setup();
		renderPanel();
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "main");
		expect(
			await screen.findByTestId("workspace-search-truncated-chip"),
		).toBeInTheDocument();
	});

	it("renders the empty-state status when the server returns zero matches", async () => {
		apiMocks.searchWorkspace.mockResolvedValue({
			matches: [],
			truncated: false,
		});
		const user = userEvent.setup();
		renderPanel();
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "nothing-matches");
		const status = await screen.findByTestId("workspace-search-status");
		await waitFor(() => {
			expect(status.textContent).toMatch(/No matches/i);
		});
	});

	it("clicking a result fires onOpenResult + onClose", async () => {
		const onOpenResult = vi.fn();
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPanel({ onOpenResult, onClose });
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "main");
		const row = await screen.findByTestId(
			"workspace-search-result-src/main.rs-17",
		);
		await user.click(row);

		expect(onOpenResult).toHaveBeenCalledWith("src/main.rs", 17);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("Enter on the active row fires onOpenResult + onClose", async () => {
		const onOpenResult = vi.fn();
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPanel({ onOpenResult, onClose });
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "main");
		// Wait for results to render so activeIndex points at the first row.
		await screen.findByTestId("workspace-search-result-src/main.rs-17");

		// Press Enter — the panel's outer keydown handler activates the
		// row at activeIndex (0 by default).
		fireEvent.keyDown(screen.getByTestId("workspace-search-panel"), {
			key: "Enter",
		});

		expect(onOpenResult).toHaveBeenCalledWith("src/main.rs", 17);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("ArrowDown advances the active row index", async () => {
		const user = userEvent.setup();
		renderPanel();
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "main");
		await screen.findByTestId("workspace-search-result-src/main.rs-17");

		// First row active by default.
		expect(
			screen.getByTestId("workspace-search-result-src/main.rs-17"),
		).toHaveAttribute("data-active", "true");

		fireEvent.keyDown(screen.getByTestId("workspace-search-panel"), {
			key: "ArrowDown",
		});
		await waitFor(() => {
			expect(
				screen.getByTestId("workspace-search-result-src/lib.rs-4"),
			).toHaveAttribute("data-active", "true");
		});
	});

	it("ArrowUp from the first row wraps to the last row", async () => {
		const user = userEvent.setup();
		renderPanel();
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "main");
		await screen.findByTestId("workspace-search-result-src/main.rs-17");

		fireEvent.keyDown(screen.getByTestId("workspace-search-panel"), {
			key: "ArrowUp",
		});
		await waitFor(() => {
			expect(
				screen.getByTestId("workspace-search-result-tests/integration.rs-42"),
			).toHaveAttribute("data-active", "true");
		});
	});

	it("clicking the backdrop closes the panel", async () => {
		const onClose = vi.fn();
		renderPanel({ onClose });
		const panel = await screen.findByTestId("workspace-search-panel");
		fireEvent.click(panel);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("clicking the close button fires onClose", async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPanel({ onClose });
		const closeBtn = screen.getByRole("button", { name: /Close search/i });
		await user.click(closeBtn);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("surfaces server errors as an error-toned status line", async () => {
		apiMocks.searchWorkspace.mockRejectedValue(
			new Error("workspace.search failed: not a git repository"),
		);
		const user = userEvent.setup();
		renderPanel();
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "boom");
		const status = await screen.findByTestId("workspace-search-status");
		await waitFor(() => {
			expect(status.textContent).toMatch(/not a git repository/i);
		});
	});

	it("forwards a remote runtime name verbatim so the wire path picks it up", async () => {
		const user = userEvent.setup();
		renderPanel({ runtimeName: "dev.box" });
		const input = await screen.findByPlaceholderText(/search files/i);
		await user.type(input, "TODO");
		await waitFor(() => expect(apiMocks.searchWorkspace).toHaveBeenCalled(), {
			timeout: 1000,
		});
		const call = apiMocks.searchWorkspace.mock.calls.at(-1)?.[0];
		expect(call.runtimeName).toBe("dev.box");
	});
});
