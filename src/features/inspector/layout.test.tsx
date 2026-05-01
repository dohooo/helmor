import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import {
	InspectorTabsSection,
	TABS_BLUR_HOLD_UNTIL_MS,
	TABS_HOVER_ZOOM_MULTIPLIER,
} from "./layout";

describe("InspectorTabsSection", () => {
	afterEach(() => {
		vi.useRealTimers();
		cleanup();
	});

	it("only triggers the blur pulse on explicit expand-icon clicks", () => {
		vi.useFakeTimers();

		renderWithProviders(
			<InspectorTabsSection
				wrapperRef={createRef<HTMLDivElement>()}
				open
				onToggle={vi.fn()}
				activeTab="run"
				onTabChange={vi.fn()}
				setupScriptState="idle"
				runScriptState="running"
				terminalInstances={[]}
				onAddTerminal={vi.fn()}
				onCloseTerminal={vi.fn()}
				onToggleTerminalHoverZoom={vi.fn()}
				canSpawnTerminal={false}
				canHoverExpand
			>
				<div>Terminal body</div>
			</InspectorTabsSection>,
		);

		const tabsBody = screen.getByLabelText("Inspector tabs body");
		const filterLayer = tabsBody.parentElement as HTMLElement;
		const expandButton = screen.getByRole("button", { name: "Expand panel" });

		// Hovering / mouse-entering the body must NOT engage the zoom — the
		// regression we're guarding against is the panel growing while the
		// user is just navigating or typing in the terminal.
		fireEvent.mouseEnter(tabsBody);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(filterLayer).toHaveStyle({ filter: "blur(0)" });

		// Clicking the explicit toggle is the only way to engage zoom.
		fireEvent.click(expandButton);
		expect(filterLayer).toHaveStyle({ filter: "blur(6px)" });

		act(() => {
			vi.advanceTimersByTime(TABS_BLUR_HOLD_UNTIL_MS);
		});
		expect(filterLayer).toHaveStyle({ filter: "blur(0)" });
	});

	it("stays zoomed when the active tab becomes non-zoomable until the pointer leaves", () => {
		vi.useFakeTimers();

		const view = renderWithProviders(
			<InspectorTabsSection
				wrapperRef={createRef<HTMLDivElement>()}
				open
				onToggle={vi.fn()}
				activeTab="run"
				onTabChange={vi.fn()}
				setupScriptState="idle"
				runScriptState="running"
				terminalInstances={[]}
				onAddTerminal={vi.fn()}
				onCloseTerminal={vi.fn()}
				onToggleTerminalHoverZoom={vi.fn()}
				canSpawnTerminal={false}
				canHoverExpand
			>
				<div>Terminal body</div>
			</InspectorTabsSection>,
		);

		const zoomContainer = screen.getByLabelText("Inspector section Tabs")
			.parentElement as HTMLElement;
		const expectedZoomedSize = `${TABS_HOVER_ZOOM_MULTIPLIER * 100}%`;
		const expandButton = screen.getByRole("button", { name: "Expand panel" });

		// Mark the pointer as inside the container before clicking — the
		// canHoverExpand effect uses this ref to decide whether to auto-collapse.
		fireEvent.mouseEnter(zoomContainer);
		fireEvent.click(expandButton);
		act(() => {
			vi.advanceTimersByTime(TABS_BLUR_HOLD_UNTIL_MS);
		});

		expect(zoomContainer).toHaveStyle({ width: expectedZoomedSize });

		view.rerender(
			<InspectorTabsSection
				wrapperRef={createRef<HTMLDivElement>()}
				open
				onToggle={vi.fn()}
				activeTab="setup"
				onTabChange={vi.fn()}
				setupScriptState="idle"
				runScriptState="running"
				terminalInstances={[]}
				onAddTerminal={vi.fn()}
				onCloseTerminal={vi.fn()}
				onToggleTerminalHoverZoom={vi.fn()}
				canSpawnTerminal={false}
				canHoverExpand={false}
			>
				<div>Placeholder body</div>
			</InspectorTabsSection>,
		);

		expect(zoomContainer).toHaveStyle({ width: expectedZoomedSize });

		fireEvent.mouseLeave(zoomContainer);

		expect(zoomContainer.firstElementChild?.firstElementChild).toHaveStyle({
			filter: "blur(6px)",
		});
	});

	it("hides the expand toggle when canHoverExpand is false", () => {
		renderWithProviders(
			<InspectorTabsSection
				wrapperRef={createRef<HTMLDivElement>()}
				open
				onToggle={vi.fn()}
				activeTab="setup"
				onTabChange={vi.fn()}
				setupScriptState="idle"
				runScriptState="idle"
				terminalInstances={[]}
				onAddTerminal={vi.fn()}
				onCloseTerminal={vi.fn()}
				onToggleTerminalHoverZoom={vi.fn()}
				canSpawnTerminal={false}
				canHoverExpand={false}
			>
				<div>Placeholder body</div>
			</InspectorTabsSection>,
		);

		expect(screen.queryByRole("button", { name: "Expand panel" })).toBeNull();
	});
});
