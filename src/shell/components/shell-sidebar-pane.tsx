// Left workspace sidebar — workspaces list, app-update button, sidebar
// collapse, and the settings entry button at the bottom.
import { PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspacesSidebarContainer } from "@/features/navigation/container";
import { SettingsButton } from "@/features/settings";
import { getShortcut } from "@/features/shortcuts/registry";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import { AppUpdateButton } from "@/features/updater/app-update-button";
import type { AppUpdateStatus } from "@/lib/api";
import type { AppSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";

type Props = {
	collapsed: boolean;
	resizing: boolean;
	width: number;
	selectedWorkspaceId: string | null;
	autoSelectEnabled: boolean;
	busyWorkspaceIds: Set<string>;
	interactionRequiredWorkspaceIds: Set<string>;
	newWorkspaceShortcut: string | null;
	addRepositoryShortcut: string | null;
	leftSidebarToggleShortcut: string | null;
	appUpdateStatus: AppUpdateStatus | null;
	appSettings: AppSettings;
	onSelectWorkspace: (workspaceId: string | null) => void;
	onOpenNewWorkspace: () => void;
	onAddRepositoryNeedsStart: (repositoryId: string) => void;
	onMoveLocalToWorktree: (workspaceId: string) => void;
	onCollapseSidebar: () => void;
	onOpenSettings: () => void;
	pushWorkspaceToast: PushWorkspaceToast;
};

export function ShellSidebarPane({
	collapsed,
	resizing,
	width,
	selectedWorkspaceId,
	autoSelectEnabled,
	busyWorkspaceIds,
	interactionRequiredWorkspaceIds,
	newWorkspaceShortcut,
	addRepositoryShortcut,
	leftSidebarToggleShortcut,
	appUpdateStatus,
	appSettings,
	onSelectWorkspace,
	onOpenNewWorkspace,
	onAddRepositoryNeedsStart,
	onMoveLocalToWorktree,
	onCollapseSidebar,
	onOpenSettings,
	pushWorkspaceToast,
}: Props) {
	return (
		<aside
			aria-hidden={collapsed}
			aria-label="Workspace sidebar"
			data-helmor-sidebar-root
			className={cn(
				"relative flex h-full shrink-0 flex-col overflow-hidden bg-sidebar",
				resizing
					? "transition-none"
					: "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
				collapsed ? "pointer-events-none" : "",
			)}
			style={{ width: collapsed ? 0 : `${width}px` }}
		>
			<div
				className={cn(
					"relative flex h-full shrink-0 flex-col transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
					collapsed
						? "-translate-x-full opacity-0"
						: "translate-x-0 opacity-100",
				)}
				style={{ width: `${width}px` }}
			>
				<div className="min-h-0 flex-1">
					<WorkspacesSidebarContainer
						selectedWorkspaceId={selectedWorkspaceId}
						autoSelectEnabled={autoSelectEnabled}
						busyWorkspaceIds={busyWorkspaceIds}
						interactionRequiredWorkspaceIds={interactionRequiredWorkspaceIds}
						newWorkspaceShortcut={newWorkspaceShortcut}
						addRepositoryShortcut={addRepositoryShortcut}
						onSelectWorkspace={onSelectWorkspace}
						onOpenNewWorkspace={onOpenNewWorkspace}
						onAddRepositoryNeedsStart={onAddRepositoryNeedsStart}
						onMoveLocalToWorktree={onMoveLocalToWorktree}
						pushWorkspaceToast={pushWorkspaceToast}
					/>
				</div>
				<div className="absolute right-[12px] top-[6px] z-20 flex items-center gap-[2px]">
					<AppUpdateButton status={appUpdateStatus} />
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								aria-label="Collapse left sidebar"
								onClick={onCollapseSidebar}
								variant="ghost"
								size="icon-xs"
								className="text-muted-foreground hover:text-foreground"
							>
								<PanelLeftClose className="size-4" strokeWidth={1.8} />
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="bottom"
							className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
						>
							<span>Collapse left sidebar</span>
							{leftSidebarToggleShortcut ? (
								<InlineShortcutDisplay
									hotkey={leftSidebarToggleShortcut}
									className="text-background/60"
								/>
							) : null}
						</TooltipContent>
					</Tooltip>
				</div>
				<div className="flex shrink-0 items-center justify-between px-3 pb-3 pt-1">
					<SettingsButton
						onClick={onOpenSettings}
						shortcut={getShortcut(appSettings.shortcuts, "settings.open")}
					/>
				</div>
			</div>
		</aside>
	);
}
