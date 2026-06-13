// Left-side header strip used when the workspace sidebar is collapsed.
// Reserves space for the macOS traffic lights and surfaces the
// app-update button + an inline "expand sidebar" toggle.
import { PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import { AppUpdateButton } from "@/features/updater/app-update-button";
import type { AppUpdateStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
	appUpdateStatus: AppUpdateStatus | null;
	leftSidebarToggleShortcut: string | null;
	showOnDesktop: boolean;
	onExpandSidebar: () => void;
};

export function WorkspaceHeaderLeading({
	appUpdateStatus,
	leftSidebarToggleShortcut,
	showOnDesktop,
	onExpandSidebar,
}: Props) {
	return (
		<div
			className={cn(
				"flex h-full shrink-0 items-center",
				showOnDesktop ? "" : "min-[961px]:hidden",
			)}
		>
			{/* Spacer to avoid macOS traffic lights */}
			<div className="w-[62px] shrink-0 max-[960px]:hidden" />
			<div className="flex items-center gap-[2px]">
				<AppUpdateButton status={showOnDesktop ? appUpdateStatus : null} />
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							aria-label="Expand left sidebar"
							onClick={onExpandSidebar}
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground hover:text-foreground max-[960px]:hidden"
						>
							<PanelLeftOpen className="size-4" strokeWidth={1.8} />
						</Button>
					</TooltipTrigger>
					<TooltipContent
						side="bottom"
						className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
					>
						<span>Expand left sidebar</span>
						{leftSidebarToggleShortcut ? (
							<InlineShortcutDisplay
								hotkey={leftSidebarToggleShortcut}
								className="text-background/60"
							/>
						) : null}
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
