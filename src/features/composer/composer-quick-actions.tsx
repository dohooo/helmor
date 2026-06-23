import { ListTree } from "lucide-react";
import type { ComponentType } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ComposerQuickAction = {
	id: string;
	label: string;
	/** Prompt sent verbatim when the tag is clicked — typically a slash
	 *  command that triggers the matching skill (e.g. `/helmor-cli restack`). */
	prompt: string;
	icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
};

// Default quick actions. Each tag fires a preset prompt on click — for now
// just Restack, which kicks off the stacked-PR restack skill.
const DEFAULT_QUICK_ACTIONS: ComposerQuickAction[] = [
	{
		id: "restack",
		// Catalog key; translated at render.
		label: "restack",
		prompt: "/helmor-cli restack",
		icon: ListTree,
	},
];

type ComposerQuickActionsProps = {
	actions?: ComposerQuickAction[];
	onAction: (action: ComposerQuickAction) => void;
	disabled?: boolean;
};

/**
 * Row of one-click quick-action tags that sits above the composer. Clicking a
 * tag dispatches its preset prompt. Rendered inside the composer's floating
 * column so it stacks naturally with the other bars (queue, goal banner) and
 * gets pushed up instead of overlapping them.
 */
export function ComposerQuickActions({
	actions = DEFAULT_QUICK_ACTIONS,
	onAction,
	disabled,
}: ComposerQuickActionsProps) {
	const { t } = useI18n();
	if (actions.length === 0) return null;
	return (
		<div className="pointer-events-auto mb-1.5 flex w-full flex-wrap items-center justify-start gap-1.5 self-stretch pl-1">
			{actions.map((action) => {
				const Icon = action.icon;
				return (
					<button
						key={action.id}
						type="button"
						disabled={disabled}
						onClick={() => onAction(action)}
						className={cn(
							"inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/50 bg-sidebar/90 px-2 py-1 text-small font-medium text-muted-foreground backdrop-blur transition-colors hover:border-border hover:bg-accent/60 hover:text-foreground",
							disabled &&
								"cursor-not-allowed opacity-50 hover:border-border/50 hover:bg-sidebar/90 hover:text-muted-foreground",
						)}
					>
						{Icon ? (
							<Icon className="size-3 shrink-0" strokeWidth={1.8} />
						) : null}
						<span>{t(action.label)}</span>
					</button>
				);
			})}
		</div>
	);
}
