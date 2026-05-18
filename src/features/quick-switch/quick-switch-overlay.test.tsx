import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRow } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";
import { QuickSwitchOverlay } from "./quick-switch-overlay";

function row(
	id: string,
	title: string,
	extra?: Partial<WorkspaceRow>,
): WorkspaceRow {
	return { id, title, ...extra };
}

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

describe("QuickSwitchOverlay", () => {
	it("renders nothing when phase is idle", () => {
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "idle" }}
				getRow={() => null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		expect(screen.queryByTestId("quick-switch-overlay")).toBeNull();
	});

	it("renders one card per resolvable id and marks the active one", () => {
		const rows = new Map([
			["a", row("a", "Alpha")],
			["b", row("b", "Beta")],
			["c", row("c", "Gamma")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b", "c"], index: 1 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		const buttons = screen.getAllByRole("button");
		expect(buttons).toHaveLength(3);
		expect(buttons[0].getAttribute("data-active")).toBe("false");
		expect(buttons[1].getAttribute("data-active")).toBe("true");
		expect(buttons[2].getAttribute("data-active")).toBe("false");
	});

	it("hovering a card triggers onSelectIndex with that index", () => {
		const onSelectIndex = vi.fn();
		const rows = new Map([
			["a", row("a", "Alpha")],
			["b", row("b", "Beta")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={onSelectIndex}
				onCommitIndex={vi.fn()}
			/>,
		);
		fireEvent.mouseEnter(screen.getAllByRole("button")[1]);
		expect(onSelectIndex).toHaveBeenCalledWith(1);
	});

	it("clicking a card fires onCommitIndex with that index", () => {
		const onCommitIndex = vi.fn();
		const rows = new Map([
			["a", row("a", "Alpha")],
			["b", row("b", "Beta")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={onCommitIndex}
			/>,
		);
		fireEvent.click(screen.getAllByRole("button")[1]);
		expect(onCommitIndex).toHaveBeenCalledWith(1);
	});

	it("filters out unresolvable ids without crashing", () => {
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["missing-a", "b"], index: 1 }}
				getRow={(id) => (id === "b" ? row("b", "Beta") : null)}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(screen.getByText("Beta")).toBeTruthy();
	});

	it("returns null when no ids resolve", () => {
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["x", "y"], index: 0 }}
				getRow={() => null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		expect(screen.queryByTestId("quick-switch-overlay")).toBeNull();
	});

	it("prefers session title over branch-derived row.title (no duplication)", () => {
		// Mirrors a real Helmor row where `row.title` is itself derived from
		// the branch — without the shared title chain we'd render
		// "Cmd Tab Switcher" twice (once as title, once as subtitle).
		const rows = new Map([
			[
				"a",
				row("a", "Cmd Tab Switcher", {
					repoName: "helmor",
					branch: "feature/cmd-tab-switcher",
					primarySessionTitle: "Designing the overlay",
				}),
			],
			["b", row("b", "Beta")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		// Title comes from the session, not the redundant row.title.
		expect(screen.getByText("Designing the overlay")).toBeTruthy();
		// Subtitle: repo › branch.
		expect(screen.getByText("helmor › feature/cmd-tab-switcher")).toBeTruthy();
	});

	it("falls back to humanized branch when no PR / session title is available", () => {
		const rows = new Map([
			["a", row("a", "raw-title", { branch: "feature/cmd-tab-switcher" })],
			["b", row("b", "Beta")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		expect(screen.getByText("Cmd Tab Switcher")).toBeTruthy();
		// Raw branch shows up only in the subtitle, not as a duplicate title.
		expect(screen.queryByText("raw-title")).toBeNull();
	});

	it("prefers PR title over session and branch", () => {
		const rows = new Map([
			[
				"a",
				row("a", "raw-title", {
					branch: "feature/cmd-tab-switcher",
					primarySessionTitle: "Designing the overlay",
					prTitle: "  feat: Arc-style quick switch  ",
				}),
			],
			["b", row("b", "Beta")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		// PR title wins; whitespace is trimmed.
		expect(screen.getByText("feat: Arc-style quick switch")).toBeTruthy();
		expect(screen.queryByText("Designing the overlay")).toBeNull();
	});

	it("shows a status dot in the top-right with the workspace status label", () => {
		const rows = new Map([
			["a", row("a", "Alpha", { status: "review" })],
			["b", row("b", "Beta")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		// Both cards render the dot (Beta falls back to in-progress).
		expect(screen.getByLabelText("In review")).toBeTruthy();
		expect(screen.getByLabelText("In progress")).toBeTruthy();
	});

	it("pinned and un-pinned rows render the same status dot", () => {
		// The dot tracks `row.status` only — pinned is sidebar-grouping
		// metadata, never a status color override. Matches the hover
		// card's long-standing behavior.
		const rows = new Map([
			[
				"a",
				row("a", "Alpha", {
					pinnedAt: "2025-01-01T00:00:00Z",
					status: "review",
				}),
			],
			["b", row("b", "Beta", { status: "review" })],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		const dots = screen.getAllByLabelText("In review");
		expect(dots).toHaveLength(2);
		expect(dots[0].className).toBe(dots[1].className);
	});

	it("skips 'Untitled' session titles in the title chain", () => {
		// With no PR / valid session / branch, we fall all the way through
		// to row.title — but 'Untitled' itself must never appear.
		const rows = new Map([
			["a", row("a", "Alpha", { primarySessionTitle: "Untitled" })],
			["b", row("b", "Beta")],
		]);
		renderWithProviders(
			<QuickSwitchOverlay
				state={{ phase: "open", ids: ["a", "b"], index: 0 }}
				getRow={(id) => rows.get(id) ?? null}
				onSelectIndex={vi.fn()}
				onCommitIndex={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Untitled")).toBeNull();
		expect(screen.getByText("Alpha")).toBeTruthy();
	});
});
