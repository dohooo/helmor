import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type AppSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import { useContextPanelController } from "./use-context-panel-controller";
import type { ShellViewMode } from "./use-selection-controller";

function renderController(
	overrides: {
		appSettings?: Partial<AppSettings>;
		viewMode?: ShellViewMode;
		updateSettings?: (patch: Partial<AppSettings>) => void;
	} = {},
) {
	const updateSettings = overrides.updateSettings ?? vi.fn();
	const viewMode = overrides.viewMode ?? "conversation";
	return {
		updateSettings,
		...renderHook(() =>
			useContextPanelController({
				appSettings: {
					...DEFAULT_SETTINGS,
					...overrides.appSettings,
				},
				areSettingsLoaded: true,
				updateSettings,
				getViewMode: () => viewMode,
			}),
		),
	};
}

describe("useContextPanelController", () => {
	it("keeps a manually collapsed workspace context sidebar collapsed on workspace sync", async () => {
		const { result } = renderController({
			appSettings: {
				lastSurface: "workspace",
				workspaceRightSidebarMode: "context",
			},
		});

		await waitFor(() => {
			expect(result.current.state.contextPanelOpen).toBe(true);
		});

		act(() => {
			result.current.actions.setInspectorCollapsed(true);
		});
		expect(result.current.state.contextPanelOpen).toBe(false);

		act(() => {
			result.current.actions.syncToWorkspaceMode();
		});

		expect(result.current.state.rightSidebarMode).toBe("context");
		expect(result.current.state.inspectorCollapsed).toBe(true);
		expect(result.current.state.contextPanelOpen).toBe(false);
	});
});
