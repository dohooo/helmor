// Left workspace sidebar — workspaces list, app-update button, sidebar
// collapse, and the settings entry button at the bottom.
import { PanelLeftClose } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { FeedbackButton } from "@/features/feedback";
import { WorkspacesSidebarContainer } from "@/features/navigation/container";
import { SettingsButton } from "@/features/settings";
import { getShortcut } from "@/features/shortcuts/registry";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import { AppUpdateButton } from "@/features/updater/app-update-button";
import type { AppUpdateStatus } from "@/lib/api";
import type { AppSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import {
	useRouterIsStart,
	useRouterSelectedWorkspaceId,
} from "@/router/use-router-selection";
import { useEdgePeek } from "@/shell/hooks/use-edge-peek";
import { useEdgeSwipe } from "@/shell/hooks/use-edge-swipe";
import { EdgeSwipeLayer } from "./edge-swipe-layer";

type Props = {
	collapsed: boolean;
	resizing: boolean;
	width: number;
	// Settings-side half of the auto-select gate
	// (`areSettingsLoaded && !restoreStartSurface`). AND'd inside with the
	// store-subscribed `viewMode !== "start"` — neither half lives in the
	// selection store, so AppShell still hands this in as a prop.
	autoSelectSettingsGate: boolean;
	busyWorkspaceIds: Set<string>;
	interactionRequiredWorkspaceIds: Set<string>;
	newWorkspaceShortcut: string | null;
	addRepositoryShortcut: string | null;
	sidebarFilterShortcut: string | null;
	leftSidebarToggleShortcut: string | null;
	appUpdateStatus: AppUpdateStatus | null;
	appSettings: AppSettings;
	onSelectWorkspace: (workspaceId: string | null) => void;
	onOpenNewWorkspace: () => void;
	onAddRepositoryNeedsStart: (repositoryId: string) => void;
	onMoveLocalToWorktree: (workspaceId: string) => void;
	onCollapseSidebar: () => void;
	onOpenFeedback: () => void;
	onOpenSettings: () => void;
	pushWorkspaceToast: PushWorkspaceToast;
};

export function ShellSidebarPane({
	collapsed,
	resizing,
	width,
	autoSelectSettingsGate,
	busyWorkspaceIds,
	interactionRequiredWorkspaceIds,
	newWorkspaceShortcut,
	addRepositoryShortcut,
	sidebarFilterShortcut,
	leftSidebarToggleShortcut,
	appUpdateStatus,
	appSettings,
	onSelectWorkspace,
	onOpenNewWorkspace,
	onAddRepositoryNeedsStart,
	onMoveLocalToWorktree,
	onCollapseSidebar,
	onOpenFeedback,
	onOpenSettings,
	pushWorkspaceToast,
}: Props) {
	// Read the selected workspace + start flag from the ROUTER (Stage 3b: the
	// router owns navigation intent). Both come from the same location, so the
	// `start → null` highlight derivation and the auto-select gate stay mutually
	// consistent — and lag-free, since the router is now authoritative (no
	// store→router microtask gap that could let auto-select fight openStart).
	const selectedWorkspaceId = useRouterSelectedWorkspaceId();
	const isStart = useRouterIsStart();
	// In Start mode nothing in the list is the active workspace — drop the
	// highlight. Mirrors AppShell's old `viewMode === "start" ? null : id` prop.
	const highlightedWorkspaceId = isStart ? null : selectedWorkspaceId;
	// AND the settings-side gate with the live start flag: auto-select must stay
	// off while the start surface is showing. Same expression AppShell used to
	// flatten into the `autoSelectEnabled` prop.
	const autoSelectEnabled = autoSelectSettingsGate && !isStart;

	// Inline width written via ref so each remount re-applies it.
	const asideRef = useRef<HTMLElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const {
		open: peekOpen,
		coarse,
		peekHandlers,
		openNow,
		close,
	} = useEdgePeek();
	const swipeHandlers = useEdgeSwipe({ side: "left", onOpen: openNow });
	useLayoutEffect(() => {
		if (asideRef.current) {
			asideRef.current.style.width = collapsed ? "0px" : `${width}px`;
		}
		if (innerRef.current) {
			innerRef.current.style.width = `${width}px`;
		}
	}, [width, collapsed]);

	return (
		<aside
			ref={asideRef}
			aria-hidden={collapsed}
			aria-label="Workspace sidebar"
			data-helmor-sidebar-root
			data-shell-pane="sidebar"
			className={cn(
				"group/sidebar relative flex h-full shrink-0 flex-col overflow-hidden bg-sidebar max-[960px]:absolute max-[960px]:bottom-[18px] max-[960px]:left-0 max-[960px]:top-9 max-[960px]:z-50 max-[960px]:h-auto max-[960px]:!w-6 max-[960px]:!max-w-[calc(100vw-12px)] max-[960px]:overflow-visible max-[960px]:rounded-xl max-[960px]:border max-[960px]:border-transparent max-[960px]:bg-transparent max-[960px]:shadow-none max-[960px]:ring-0",
				resizing
					? "transition-none"
					: "transition-[width] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
				collapsed ? "pointer-events-none max-[960px]:pointer-events-auto" : "",
			)}
		>
			{coarse ? (
				<EdgeSwipeLayer
					side="left"
					open={peekOpen}
					label="workspace sidebar"
					onClose={close}
					swipeHandlers={swipeHandlers}
				/>
			) : null}
			<div
				data-shell-pane-hover="sidebar"
				{...peekHandlers}
				className={cn(
					"contents max-[960px]:absolute max-[960px]:inset-y-0 max-[960px]:left-0 max-[960px]:block max-[960px]:overflow-visible max-[960px]:pointer-events-auto",
					peekOpen ? "max-[960px]:!w-[332px]" : "max-[960px]:!w-6",
				)}
			>
				<div
					ref={innerRef}
					data-shell-pane-inner="sidebar"
					className={cn(
						"relative flex h-full shrink-0 flex-col transition-[opacity,translate] duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none max-[960px]:ml-3 max-[960px]:!w-[320px] max-[960px]:!max-w-[calc(100vw-24px)] max-[960px]:rounded-xl max-[960px]:border max-[960px]:border-border/70 max-[960px]:bg-sidebar max-[960px]:shadow-[0_24px_70px_rgba(0,0,0,0.22)] max-[960px]:ring-1 max-[960px]:ring-background/55 max-[960px]:will-change-transform dark:max-[960px]:shadow-[0_24px_70px_rgba(0,0,0,0.55)]",
						peekOpen
							? "max-[960px]:translate-x-0 max-[960px]:opacity-100"
							: "max-[960px]:-translate-x-full max-[960px]:opacity-0",
						collapsed
							? "-translate-x-full opacity-0"
							: "translate-x-0 opacity-100",
					)}
				>
					<div className="min-h-0 flex-1">
						<WorkspacesSidebarContainer
							selectedWorkspaceId={highlightedWorkspaceId}
							autoSelectEnabled={autoSelectEnabled}
							busyWorkspaceIds={busyWorkspaceIds}
							interactionRequiredWorkspaceIds={interactionRequiredWorkspaceIds}
							newWorkspaceShortcut={newWorkspaceShortcut}
							addRepositoryShortcut={addRepositoryShortcut}
							sidebarFilterShortcut={sidebarFilterShortcut}
							onSelectWorkspace={onSelectWorkspace}
							onOpenNewWorkspace={onOpenNewWorkspace}
							onAddRepositoryNeedsStart={onAddRepositoryNeedsStart}
							onMoveLocalToWorktree={onMoveLocalToWorktree}
							pushWorkspaceToast={pushWorkspaceToast}
						/>
					</div>
					<div className="absolute right-[12px] top-[6px] z-20 flex items-center gap-[2px]">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									aria-label="Collapse left sidebar"
									onClick={onCollapseSidebar}
									variant="ghost"
									size="icon-xs"
									className="text-muted-foreground hover:text-foreground max-[960px]:hidden"
								>
									<PanelLeftClose className="size-4" strokeWidth={1.8} />
								</Button>
							</TooltipTrigger>
							<TooltipContent
								side="bottom"
								className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
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
						<div className="flex items-center">
							<SettingsButton
								onClick={onOpenSettings}
								shortcut={getShortcut(appSettings.shortcuts, "settings.open")}
							/>
							<FeedbackButton onClick={onOpenFeedback} />
						</div>
						<AppUpdateButton status={appUpdateStatus} />
					</div>
				</div>
			</div>
		</aside>
	);
}
