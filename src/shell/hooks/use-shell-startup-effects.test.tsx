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
		lastWorkspaceId: null,
		// Default: groups NOT settled, so the WP7 Gate 4 fallback stays inert in
		// the pre-existing restore tests above (they exercise the restore only).
		workspaceGroupsSettled: false,
		hasAnyWorkspace: false,
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

	// WP7 Gate 4: brand-new user (no persisted selection, no workspaces) lands
	// on Start instead of the empty `/` boot index.
	describe("empty-boot Start fallback (WP7 Gate 4)", () => {
		const emptyBoot = (overrides: Partial<Props> = {}) =>
			makeProps({
				lastSurface: "workspace",
				workspaceGroupsSettled: true,
				hasAnyWorkspace: false,
				lastWorkspaceId: null,
				...overrides,
			});

		it("opens Start when groups settled empty and there is no history", () => {
			const openWorkspaceStart = vi.fn();
			renderHook((props: Props) => useShellStartupEffects(props), {
				initialProps: emptyBoot({ openWorkspaceStart }),
			});
			expect(openWorkspaceStart).toHaveBeenCalledTimes(1);
			expect(openWorkspaceStart).toHaveBeenCalledWith({ persist: false });
		});

		it("does NOT fire while the groups query is still loading (no hijack)", () => {
			const openWorkspaceStart = vi.fn();
			renderHook((props: Props) => useShellStartupEffects(props), {
				initialProps: emptyBoot({
					openWorkspaceStart,
					workspaceGroupsSettled: false,
				}),
			});
			expect(openWorkspaceStart).not.toHaveBeenCalled();
		});

		it("does NOT fire when workspaces exist", () => {
			const openWorkspaceStart = vi.fn();
			renderHook((props: Props) => useShellStartupEffects(props), {
				initialProps: emptyBoot({ openWorkspaceStart, hasAnyWorkspace: true }),
			});
			expect(openWorkspaceStart).not.toHaveBeenCalled();
		});

		it("does NOT fire when a persisted last workspace exists", () => {
			const openWorkspaceStart = vi.fn();
			renderHook((props: Props) => useShellStartupEffects(props), {
				initialProps: emptyBoot({
					openWorkspaceStart,
					lastWorkspaceId: "w1",
				}),
			});
			expect(openWorkspaceStart).not.toHaveBeenCalled();
		});

		it("decides exactly once — a later empty state cannot hijack the session", () => {
			const openWorkspaceStart = vi.fn();
			// Boot with workspaces present: decision is made (and is a no-op).
			const { rerender } = renderHook(
				(props: Props) => useShellStartupEffects(props),
				{
					initialProps: emptyBoot({
						openWorkspaceStart,
						hasAnyWorkspace: true,
					}),
				},
			);
			expect(openWorkspaceStart).not.toHaveBeenCalled();
			// All workspaces later deleted mid-session → still no hijack.
			rerender(emptyBoot({ openWorkspaceStart, hasAnyWorkspace: false }));
			expect(openWorkspaceStart).not.toHaveBeenCalled();
		});

		it("stays inert when already on a clean start surface", () => {
			const openWorkspaceStart = vi.fn();
			renderHook((props: Props) => useShellStartupEffects(props), {
				initialProps: emptyBoot({
					openWorkspaceStart,
					workspaceViewMode: "start",
				}),
			});
			expect(openWorkspaceStart).not.toHaveBeenCalled();
		});
	});
});
