import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import {
	InspectorTabsSection,
	TABS_BLUR_HOLD_UNTIL_MS,
	TABS_HOVER_ACTIVATION_MS,
	TABS_HOVER_ZOOM_MULTIPLIER,
} from "./layout";

describe("InspectorTabsSection", () => {
	afterEach(() => {
		vi.useRealTimers();
		cleanup();
	});

	it("does not re-trigger blur when moving from header back into body while zoomed", () => {
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
				runActions={[]}
				activeRunActionId={null}
				onSelectRunAction={vi.fn()}
				onCreateRunAction={vi.fn()}
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
		const header = screen.getByRole("tablist").parentElement as HTMLElement;

		fireEvent.mouseEnter(tabsBody);
		act(() => {
			vi.advanceTimersByTime(TABS_HOVER_ACTIVATION_MS);
		});

		expect(filterLayer).toHaveStyle({ filter: "blur(6px)" });

		act(() => {
			vi.advanceTimersByTime(TABS_BLUR_HOLD_UNTIL_MS);
		});

		expect(filterLayer).toHaveStyle({ filter: "blur(0)" });

		fireEvent.mouseEnter(header);
		fireEvent.mouseEnter(tabsBody);

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
				runActions={[]}
				activeRunActionId={null}
				onSelectRunAction={vi.fn()}
				onCreateRunAction={vi.fn()}
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
		const zoomContainer = screen.getByLabelText("Inspector section Tabs")
			.parentElement as HTMLElement;
		const expectedZoomedSize = `${TABS_HOVER_ZOOM_MULTIPLIER * 100}%`;

		fireEvent.mouseEnter(zoomContainer);
		fireEvent.mouseEnter(tabsBody);
		act(() => {
			vi.advanceTimersByTime(TABS_HOVER_ACTIVATION_MS);
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
				runActions={[]}
				activeRunActionId={null}
				onSelectRunAction={vi.fn()}
				onCreateRunAction={vi.fn()}
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

	it("renders the Run dropdown chevron and exposes 'Create'", async () => {
		const onCreate = vi.fn();
		const onSelect = vi.fn();
		const { userEvent: makeUser } = await import("@testing-library/user-event");
		const user = makeUser.setup();
		renderWithProviders(
			<InspectorTabsSection
				wrapperRef={createRef<HTMLDivElement>()}
				open
				onToggle={vi.fn()}
				activeTab="run"
				onTabChange={vi.fn()}
				setupScriptState="idle"
				runScriptState="idle"
				runActions={[
					{
						id: "a1",
						name: "Dev",
						command: "npm run dev",
						mode: "concurrent",
						fromProject: false,
					},
					{
						id: "a2",
						name: "Tests",
						command: "npm test",
						mode: "concurrent",
						fromProject: false,
					},
				]}
				activeRunActionId="a1"
				onSelectRunAction={onSelect}
				onCreateRunAction={onCreate}
				terminalInstances={[]}
				onAddTerminal={vi.fn()}
				onCloseTerminal={vi.fn()}
				onToggleTerminalHoverZoom={vi.fn()}
				canSpawnTerminal={false}
				canHoverExpand
			>
				<div>Body</div>
			</InspectorTabsSection>,
		);

		// Chevron trigger sits next to the Run tab. Click opens the menu.
		const trigger = screen.getByRole("button", { name: /switch run action/i });
		await user.click(trigger);

		// Both actions and the Create entry are now in the menu.
		expect(
			screen.getByRole("menuitemradio", { name: /^dev$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitemradio", { name: /^tests$/i }),
		).toBeInTheDocument();
		const createEntry = screen.getByRole("menuitem", {
			name: /^create$/i,
		});

		await user.click(createEntry);
		expect(onCreate).toHaveBeenCalledTimes(1);
	});

	it("Run dropdown radio selection fires onSelectRunAction", async () => {
		const onSelect = vi.fn();
		const { userEvent: makeUser } = await import("@testing-library/user-event");
		const user = makeUser.setup();
		renderWithProviders(
			<InspectorTabsSection
				wrapperRef={createRef<HTMLDivElement>()}
				open
				onToggle={vi.fn()}
				activeTab="run"
				onTabChange={vi.fn()}
				setupScriptState="idle"
				runScriptState="idle"
				runActions={[
					{
						id: "a1",
						name: "Dev",
						command: "npm run dev",
						mode: "concurrent",
						fromProject: false,
					},
					{
						id: "a2",
						name: "Tests",
						command: "npm test",
						mode: "concurrent",
						fromProject: false,
					},
				]}
				activeRunActionId="a1"
				onSelectRunAction={onSelect}
				onCreateRunAction={vi.fn()}
				terminalInstances={[]}
				onAddTerminal={vi.fn()}
				onCloseTerminal={vi.fn()}
				onToggleTerminalHoverZoom={vi.fn()}
				canSpawnTerminal={false}
				canHoverExpand
			>
				<div>Body</div>
			</InspectorTabsSection>,
		);

		await user.click(
			screen.getByRole("button", { name: /switch run action/i }),
		);
		await user.click(screen.getByRole("menuitemradio", { name: /^tests$/i }));
		expect(onSelect).toHaveBeenCalledWith("a2");
	});
});
