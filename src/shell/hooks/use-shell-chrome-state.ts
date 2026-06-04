// Shell chrome + editor-preference glue. Owns the detected-editor list and the
// user's preferred-editor pick, the resolved keyboard shortcuts + global hotkey
// sync, the chrome action handlers (theme/zen/model-picker/changelog), the
// "open in preferred editor" command, and the pull-latest action. Split out of
// `useAppShellState` to keep that orchestration hub focused — this is leaf glue
// that depends only on settings + the resolved panel/context-panel collapse
// state. Extracted verbatim from AppShell; dependency arrays are preserved.
import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useState,
} from "react";
import { toast } from "sonner";
import { getShortcut } from "@/features/shortcuts/registry";
import { useGlobalHotkeySync } from "@/features/shortcuts/use-global-hotkey-sync";
import { openWorkspaceInEditor, toggleMiniWindowMode } from "@/lib/api";
import { detectedEditorsQueryOptions } from "@/lib/query-client";
import type { AppSettings, ShortcutOverrides } from "@/lib/settings";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { usePullLatest } from "@/shell/hooks/use-pull-latest";
import { useResolvedShortcuts } from "@/shell/hooks/use-resolved-shortcuts";
import { useShellChromeActions } from "@/shell/hooks/use-shell-chrome-actions";
import { PREFERRED_EDITOR_STORAGE_KEY } from "@/shell/layout";

export function useShellChromeState({
	queryClient,
	pushWorkspaceToast,
	appSettings,
	areSettingsLoaded,
	updateSettings,
	selectedWorkspaceId,
	sidebarCollapsed,
	inspectorCollapsed,
	setSidebarCollapsed,
	setInspectorCollapsed,
}: {
	queryClient: QueryClient;
	pushWorkspaceToast: PushWorkspaceToast;
	appSettings: AppSettings;
	areSettingsLoaded: boolean;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
	selectedWorkspaceId: string | null;
	sidebarCollapsed: boolean;
	inspectorCollapsed: boolean;
	setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
	setInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
}) {
	const installedEditorsQuery = useQuery(detectedEditorsQueryOptions());
	const installedEditors = installedEditorsQuery.data ?? [];
	const [preferredEditorId, setPreferredEditorId] = useState<string | null>(
		() => localStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY),
	);
	const preferredEditor =
		installedEditors.find((e) => e.id === preferredEditorId) ??
		installedEditors[0] ??
		null;
	const {
		openPreferredEditorShortcut,
		newWorkspaceShortcut,
		addRepositoryShortcut,
		sidebarFilterShortcut,
		leftSidebarToggleShortcut,
		rightSidebarToggleShortcut,
	} = useResolvedShortcuts(appSettings.shortcuts);
	const handleUpdateGlobalHotkeyShortcuts = useCallback(
		(shortcuts: ShortcutOverrides) => updateSettings({ shortcuts }),
		[updateSettings],
	);
	useGlobalHotkeySync({
		isLoaded: areSettingsLoaded,
		shortcuts: appSettings.shortcuts,
		updateShortcuts: handleUpdateGlobalHotkeyShortcuts,
	});
	const handleOpenPreferredEditor = useCallback(() => {
		if (!selectedWorkspaceId || !preferredEditor) return;
		void openWorkspaceInEditor(selectedWorkspaceId, preferredEditor.id).catch(
			(e) =>
				pushWorkspaceToast(String(e), `Failed to open ${preferredEditor.name}`),
		);
	}, [preferredEditor, pushWorkspaceToast, selectedWorkspaceId]);
	const {
		handleToggleTheme,
		handleToggleZenMode,
		handleOpenModelPicker,
		handleOpenReleaseChangelog,
	} = useShellChromeActions({
		theme: appSettings.theme,
		updateSettings,
		sidebarCollapsed,
		inspectorCollapsed,
		setSidebarCollapsed,
		setInspectorCollapsed,
	});
	const handlePullLatest = usePullLatest({ queryClient, selectedWorkspaceId });

	const [miniModePending, setMiniModePending] = useState(false);
	const handleToggleMiniMode = useCallback(() => {
		if (miniModePending) {
			return;
		}
		setMiniModePending(true);
		void toggleMiniWindowMode()
			.catch((error: unknown) => {
				console.error("[app] failed to resize window", error);
				toast.error("Unable to resize window", {
					description: String(error),
				});
			})
			.finally(() => setMiniModePending(false));
	}, [miniModePending]);
	const miniModeToggleShortcut = getShortcut(
		appSettings.shortcuts,
		"window.miniMode.toggle",
	);

	return {
		installedEditors,
		preferredEditor,
		setPreferredEditorId,
		openPreferredEditorShortcut,
		newWorkspaceShortcut,
		addRepositoryShortcut,
		sidebarFilterShortcut,
		leftSidebarToggleShortcut,
		rightSidebarToggleShortcut,
		handleOpenPreferredEditor,
		handleToggleTheme,
		handleToggleZenMode,
		handleOpenModelPicker,
		handleOpenReleaseChangelog,
		handlePullLatest,
		miniModePending,
		handleToggleMiniMode,
		miniModeToggleShortcut,
	};
}
