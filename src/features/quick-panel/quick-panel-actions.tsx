import { ArrowUpRight, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { hideQuickPanel, revealWorkspaceInMainWindow } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

function ActionButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	const { t } = useI18n();
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onClick}
					aria-label={t(label)}
					className="px-2 text-muted-foreground hover:text-foreground"
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent
				side="bottom"
				sideOffset={4}
				className="flex h-[24px] items-center rounded-md px-2 text-small leading-none"
			>
				<span>{t(label)}</span>
			</TooltipContent>
		</Tooltip>
	);
}

export function QuickPanelCloseButton() {
	return (
		<ActionButton label="Close" onClick={() => void hideQuickPanel()}>
			<X className="size-3.5" strokeWidth={1.8} />
		</ActionButton>
	);
}

/**
 * Icon-only panel actions riding in the conversation header's actions slot —
 * one row holds branch, new, open, and close.
 */
export function QuickPanelActions({
	selectedWorkspaceId,
	selectedSessionId,
	onNewTask,
}: {
	selectedWorkspaceId: string | null;
	selectedSessionId: string | null;
	onNewTask: () => void;
}) {
	return (
		<>
			<ActionButton label="New Workspace" onClick={onNewTask}>
				<Plus className="size-3.5" strokeWidth={1.8} />
			</ActionButton>
			{selectedWorkspaceId ? (
				<ActionButton
					label="Open in Helmor"
					onClick={() =>
						void revealWorkspaceInMainWindow(
							selectedWorkspaceId,
							selectedSessionId,
						)
					}
				>
					<ArrowUpRight className="size-3.5" strokeWidth={1.8} />
				</ActionButton>
			) : null}
			<QuickPanelCloseButton />
		</>
	);
}
