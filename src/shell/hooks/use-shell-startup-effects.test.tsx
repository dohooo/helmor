import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useShellStartupEffects } from "./use-shell-startup-effects";

// Regression guards for the one-shot boot `lastSurface` restore.
//
// The bug this locks: persistence is now an async single `onResolved` settings
// writer, so `appSettings.lastSurface` lags a synchronous router navigation by a
// tick. Re-running the restore on every dep change therefore bounced the user
// back to Start the instant they navigated AWAY from it (router-derived
// viewMode flipped to "conversation" while `lastSurface` was still
// "workspace-start"). The restore must fire AT MOST once, after settings load.

type Props = Parameters<typeof useShellStartupEffects>[0];

function makeProps(overrides: Partial<Props> = {}): Props {
	return {
		lastSurface: "workspace-start",
		areSettingsLoaded: true,
		workspaceViewMode: "conversation",
		selectedWorkspaceId: null,
		displayedWorkspaceId: null,
		startRepositoryId: undefined,
		openWorkspaceStart: vi.fn(),
		closeStartContextPreview: vi.fn(),
		...overrides,
	};
}

describe("useShellStartupEffects", () => {
	it("restores the start surface once on cold boot when lastSurface is workspace-start", () => {
		const openWorkspaceStart = vi.fn();
		renderHook((props: Props) => useShellStartupEffects(props), {
			initialProps: makeProps({ openWorkspaceStart }),
		});
		expect(openWorkspaceStart).toHaveBeenCalledTimes(1);
		expect(openWorkspaceStart).toHaveBeenCalledWith({ persist: false });
	});

	it("does NOT re-open Start after the user navigates away (the bounce regression)", () => {
		const openWorkspaceStart = vi.fn();
		const { rerender } = renderHook(
			(props: Props) => useShellStartupEffects(props),
			{ initialProps: makeProps({ openWorkspaceStart }) },
		);
		expect(openWorkspaceStart).toHaveBeenCalledTimes(1);
		// User opens a workspace: router-derived viewMode/ids flip synchronously
		// while the persisted `lastSurface` still lags at "workspace-start".
		rerender(
			makeProps({
				openWorkspaceStart,
				selectedWorkspaceId: "w1",
				displayedWorkspaceId: "w1",
			}),
		);
		expect(openWorkspaceStart).toHaveBeenCalledTimes(1);
	});

	it("never opens Start when lastSurface is not workspace-start", () => {
		const openWorkspaceStart = vi.fn();
		renderHook((props: Props) => useShellStartupEffects(props), {
			initialProps: makeProps({ openWorkspaceStart, lastSurface: "workspace" }),
		});
		expect(openWorkspaceStart).not.toHaveBeenCalled();
	});

	it("does not re-open Start when already on a clean start surface", () => {
		const openWorkspaceStart = vi.fn();
		renderHook((props: Props) => useShellStartupEffects(props), {
			initialProps: makeProps({
				openWorkspaceStart,
				workspaceViewMode: "start",
			}),
		});
		expect(openWorkspaceStart).not.toHaveBeenCalled();
	});

	it("waits for settings to load before applying the one-shot restore", () => {
		const openWorkspaceStart = vi.fn();
		const { rerender } = renderHook(
			(props: Props) => useShellStartupEffects(props),
			{
				initialProps: makeProps({
					openWorkspaceStart,
					areSettingsLoaded: false,
				}),
			},
		);
		expect(openWorkspaceStart).not.toHaveBeenCalled();
		rerender(makeProps({ openWorkspaceStart, areSettingsLoaded: true }));
		expect(openWorkspaceStart).toHaveBeenCalledTimes(1);
	});
});
