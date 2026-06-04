// Shell-level overlays mounted as siblings of the main layout: the global
// toast surface, the release-announcement toast host, the Cmd+Tab quick-switch
// overlay, and the three imperative confirm-dialog nodes (close session /
// editor discard / merge). Lifted verbatim out of AppShell's return tail.
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { ReleaseAnnouncementToastHost } from "@/features/announcements";
import type { QuickSwitchControls } from "@/features/quick-switch";
import { QuickSwitchOverlay } from "@/features/quick-switch";
import type { SettingsSection } from "@/features/settings";
import type { WorkspaceRow } from "@/lib/api";
import type { AppSettings, WorkspaceRightSidebarMode } from "@/lib/settings";
import { resolveTheme } from "@/lib/settings";

type Props = {
	theme: AppSettings["theme"];
	onOpenChangelog: () => void;
	onOpenAnnouncementSettings: (section?: SettingsSection) => void;
	onSetRightSidebarMode: (mode: WorkspaceRightSidebarMode) => void;
	onOpenStartPage: () => void;
	quickSwitch: QuickSwitchControls;
	liveWorkspaceRowMap: Map<string, WorkspaceRow>;
	closeConfirmDialog: ReactNode;
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
	editorDiscardConfirmDialog,
	mergeConfirmDialogNode,
}: Props) {
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
			{editorDiscardConfirmDialog}
			{mergeConfirmDialogNode}
		</>
	);
}
