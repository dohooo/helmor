import { describe, expect, it } from "vitest";
import {
	clampVerticalSplitSizes,
	getInitialVerticalSplitSizes,
	getPrimaryPanelSize,
	openVerticalSplitPanel,
	resizeVerticalSplitPanel,
	type VerticalSplitPanelConfig,
} from "./vertical-split-layout";

const panels: VerticalSplitPanelConfig[] = [
	{ id: "changes", open: true, minSize: 96, defaultSize: 240 },
	{ id: "actions", open: true, minSize: 72, defaultSize: 160 },
	{ id: "terminal", open: false, minSize: 96, defaultSize: 180 },
];

const baseConfig = {
	containerSize: 600,
	headerSize: 33,
	minPrimarySize: 96,
	primaryPanelId: "changes",
	panels,
	sizes: {
		actions: 160,
		terminal: 180,
	},
};

describe("vertical split layout", () => {
	it("initializes panel sizes from defaults", () => {
		expect(getInitialVerticalSplitSizes(panels)).toEqual({
			changes: 240,
			actions: 160,
			terminal: 180,
		});
	});

	it("derives the primary panel size from remaining body capacity", () => {
		expect(getPrimaryPanelSize(baseConfig)).toBe(341);
	});

	it("moves the actions divider up by shrinking the primary and growing actions", () => {
		const next = resizeVerticalSplitPanel({
			...baseConfig,
			deltaY: -80,
			panelId: "actions",
		});

		expect(next).toEqual({
			actions: 240,
			terminal: 180,
		});
	});

	it("stops moving the actions divider up when the primary reaches its minimum", () => {
		const next = resizeVerticalSplitPanel({
			...baseConfig,
			deltaY: -500,
			panelId: "actions",
		});

		expect(next).toEqual({
			actions: 405,
			terminal: 180,
		});
		expect(
			getPrimaryPanelSize({
				...baseConfig,
				sizes: next,
			}),
		).toBe(96);
	});

	it("moves the actions divider down by shrinking actions before terminal", () => {
		const openPanels = panels.map((panel) =>
			panel.id === "terminal" ? { ...panel, open: true } : panel,
		);
		const next = resizeVerticalSplitPanel({
			...baseConfig,
			panels: openPanels,
			deltaY: 300,
			panelId: "actions",
		});

		expect(next).toEqual({
			actions: 72,
			terminal: 96,
		});
	});

	it("moves the terminal divider down by shrinking terminal and growing actions", () => {
		const openPanels = panels.map((panel) =>
			panel.id === "terminal" ? { ...panel, open: true } : panel,
		);
		const next = resizeVerticalSplitPanel({
			...baseConfig,
			panels: openPanels,
			deltaY: 60,
			panelId: "terminal",
		});

		expect(next).toEqual({
			actions: 220,
			terminal: 120,
		});
	});

	it("moves the terminal divider up by shrinking actions then primary", () => {
		const openPanels = panels.map((panel) =>
			panel.id === "terminal" ? { ...panel, open: true } : panel,
		);
		const next = resizeVerticalSplitPanel({
			...baseConfig,
			panels: openPanels,
			deltaY: -300,
			panelId: "terminal",
		});

		expect(next).toEqual({
			actions: 72,
			terminal: 333,
		});
		expect(
			getPrimaryPanelSize({
				...baseConfig,
				panels: openPanels,
				sizes: next,
			}),
		).toBe(96);
	});

	it("opens a secondary panel at its remembered size and leaves siblings untouched", () => {
		const next = openVerticalSplitPanel({
			...baseConfig,
			panelId: "terminal",
		});

		// Terminal returns to its remembered size (180), actions stays put,
		// and the primary auto-shrinks to absorb the difference.
		expect(next).toEqual({
			actions: 160,
			terminal: 180,
		});
	});

	it("falls back to defaultSize when opening a panel with no remembered size", () => {
		const next = openVerticalSplitPanel({
			...baseConfig,
			sizes: { actions: 160 },
			panelId: "terminal",
		});

		expect(next).toEqual({
			actions: 160,
			terminal: 180,
		});
	});

	it("shrinks other secondary panels only as much as needed to fit the remembered size", () => {
		const next = openVerticalSplitPanel({
			...baseConfig,
			sizes: {
				actions: 405,
				terminal: 180,
			},
			panelId: "terminal",
		});

		// actions had absorbed extra space from a previous close. Opening
		// terminal at its remembered 180 only takes back what's needed —
		// it doesn't crush actions all the way to its 72px minimum.
		expect(next).toEqual({
			actions: 225,
			terminal: 180,
		});
		expect(
			getPrimaryPanelSize({
				...baseConfig,
				panels: panels.map((panel) =>
					panel.id === "terminal" ? { ...panel, open: true } : panel,
				),
				sizes: next,
			}),
		).toBe(96);
	});

	it("clamps the remembered size when it would push the primary below its minimum", () => {
		const next = openVerticalSplitPanel({
			...baseConfig,
			sizes: {
				actions: 160,
				terminal: 1000,
			},
			panelId: "terminal",
		});

		// Remembered 1000 is clamped so primary keeps its 96px floor.
		// bodyBudget(405) - actions.minSize(72) = 333.
		expect(next).toEqual({
			actions: 72,
			terminal: 333,
		});
	});

	it("clamps open panels on container resize without overflowing the primary minimum", () => {
		const openPanels = panels.map((panel) =>
			panel.id === "terminal" ? { ...panel, open: true } : panel,
		);
		const next = clampVerticalSplitSizes({
			...baseConfig,
			containerSize: 420,
			panels: openPanels,
			sizes: {
				actions: 240,
				terminal: 220,
			},
		});

		expect(next).toEqual({
			actions: 129,
			terminal: 96,
		});
		expect(
			getPrimaryPanelSize({
				...baseConfig,
				containerSize: 420,
				panels: openPanels,
				sizes: next,
			}),
		).toBe(96);
	});
});
