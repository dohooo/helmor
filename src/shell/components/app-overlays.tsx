// Shell-level overlays mounted as siblings of the main layout: the global
// toast surface, the release-announcement toast host, the Cmd+Tab quick-switch
// overlay, and the three imperative confirm-dialog nodes (close session /
// editor discard / merge). Lifted verbatim out of AppShell's return tail.
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { ReleaseAnnouncementToastHost } from "@/features/announcements";
import { usePresenceSubscription } from "@/features/navigation/state/presence-store";
import type { QuickSwitchControls } from "@/features/quick-switch";
import { QuickSwitchOverlay } from "@/features/quick-switch";
import type { SettingsSection } from "@/features/settings";
import type { WorkspaceRow } from "@/lib/api";
import type { AppSettings, WorkspaceRightSidebarMode } from "@/lib/settings";
import { resolveTheme } from "@/lib/settings";
import { useActiveStreamsReattach } from "@/shell/hooks/use-active-streams-reattach";

type Props = {
	theme: AppSettings["theme"];
	onOpenChangelog: () => void;
	onOpenAnnouncementSettings: (section?: SettingsSection) => void;
	onSetRightSidebarMode: (mode: WorkspaceRightSidebarMode) => void;
	onOpenStartPage: () => void;
	quickSwitch: QuickSwitchControls;
	liveWorkspaceRowMap: Map<string, WorkspaceRow>;
	closeConfirmDialog: ReactNode;
	terminalResumeDialog: ReactNode;
	editorDiscardConfirmDialog: ReactNode;
	mergeConfirmDialogNode: ReactNode;
};

export function AppOverlays({
	theme,
	onOpenChangelog,
	onOpenAnnouncementSettings,
	onSetRightSidebarMode,
	onOpenStartPage,
	quickSwitch,
	liveWorkspaceRowMap,
	closeConfirmDialog,
	terminalResumeDialog,
	editorDiscardConfirmDialog,
	mergeConfirmDialogNode,
}: Props) {
	// Headless: keep the active-stream re-attach side effect that used to live in
	// the (now-removed) ReconnectingBanner. Must run shell-wide for every remote
	// transport, not only where the team-mode switch renders.
	useActiveStreamsReattach();
	// Headless: fold `roomPresenceChanged` events into the presence store so
	// sidebar rows can show who's typing in a shared team workspace.
	usePresenceSubscription();

	return (
		<>
			<Toaster
				theme={resolveTheme(theme)}
				position="bottom-right"
				visibleToasts={6}
			/>
			<ReleaseAnnouncementToastHost
				onOpenChangelog={onOpenChangelog}
				onOpenSettings={onOpenAnnouncementSettings}
				onSetRightSidebarMode={onSetRightSidebarMode}
				onOpenStartPage={onOpenStartPage}
			/>
			<QuickSwitchOverlay
				state={quickSwitch.state}
				getRow={(id) => liveWorkspaceRowMap.get(id) ?? null}
				onSelectIndex={quickSwitch.selectIndex}
				onCommitIndex={(index) => {
					quickSwitch.selectIndex(index);
					quickSwitch.commit();
				}}
			/>
			{closeConfirmDialog}
			{terminalResumeDialog}
			{editorDiscardConfirmDialog}
			{mergeConfirmDialogNode}
		</>
	);
}
