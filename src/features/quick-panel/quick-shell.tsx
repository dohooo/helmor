// The quick panel's whole surface — the AppShell counterpart for the `quick`
// window. Runs the SAME `useAppShellState` orchestration (its own React root,
// router and selection, fully independent from the main window) but renders
// only the workspace pane inside a rounded floating card: no sidebar, no
// inspector, no overlays. The panel actions (new / open / close) ride in the
// conversation header's actions slot; on the start surface a lone close
// button floats top-right. Window-level behaviors live in
// `useQuickPanelWindow`; per-app singletons inside the shared hooks are gated
// by `isQuickPanelWindow`.
import { useMemo } from "react";
import { Toaster } from "@/components/ui/sonner";
import type { SettingsSection } from "@/features/settings";
import { translateSource } from "@/lib/i18n";
import { resolveTheme } from "@/lib/settings";
import { AppShellProviderStack } from "@/shell/components/app-shell-provider-stack";
import { buildWorkspacePaneProps } from "@/shell/components/workspace-pane-props";
import { WorkspacePaneSurface } from "@/shell/components/workspace-pane-surface";
import { useAppShellState } from "@/shell/hooks/use-app-shell-state";
import {
	QuickPanelActions,
	QuickPanelCloseButton,
} from "./quick-panel-actions";
import { useQuickPanelWindow } from "./use-quick-panel-window";

export function QuickShell({
	onOpenSettings,
}: {
	onOpenSettings: (
		workspaceId: string | null,
		workspaceRepoId: string | null,
		initialSection?: SettingsSection,
	) => void;
}) {
	const s = useAppShellState({ onOpenSettings });
	useQuickPanelWindow({
		openWorkspaceStart: s.handleOpenWorkspaceStart,
	});

	const { selectedWorkspaceId, selectedSessionId, handleOpenWorkspaceStart } =
		s;
	const headerActionsNode = useMemo(
		() => (
			<QuickPanelActions
				selectedWorkspaceId={selectedWorkspaceId}
				selectedSessionId={selectedSessionId}
				onNewTask={() => handleOpenWorkspaceStart({ persist: false })}
			/>
		),
		[selectedWorkspaceId, selectedSessionId, handleOpenWorkspaceStart],
	);

	const paneProps = buildWorkspacePaneProps({
		s,
		headerLeadingNode: null,
		headerActionsNode,
	});

	return (
		<AppShellProviderStack
			selectionStore={s.sel.selectionStore}
			pushWorkspaceToast={s.pushWorkspaceToast}
			sessionRunStates={s.data.effectiveSessionRunStates}
			insertIntoComposer={s.data.pendingQueueActions.insertIntoComposer}
			showQuitConfirm={false}
		>
			<Toaster
				theme={resolveTheme(s.appSettings.theme)}
				position="bottom-right"
				visibleToasts={3}
			/>
			<main
				aria-label={translateSource("quickPanel")}
				className="h-dvh w-dvw overflow-hidden bg-transparent font-sans text-foreground antialiased"
			>
				<div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background">
					{s.workspaceViewMode === "start" ? (
						<div className="absolute top-1.5 right-1.5 z-20">
							<QuickPanelCloseButton />
						</div>
					) : null}
					{/* The panel never shows the context sidebar; keep the
					    composer's toggle visually inert. */}
					<WorkspacePaneSurface
						{...paneProps}
						contextPanelOpen={false}
						startComposerAtBottom
					/>
				</div>
			</main>
		</AppShellProviderStack>
	);
}
