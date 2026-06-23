import { Play, Sparkles, X } from "lucide-react";

import { ActionRow, ActionRowButton } from "@/components/action-row";
import { I18nText } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type TriageQuickActionsProps = {
	onStart: () => void;
	onDismiss: () => void;
	/** Disable both buttons (e.g. composer is sending or archive in flight). */
	disabled?: boolean;
};

// Composer Start/Dismiss row for un-engaged triage workspaces.
export function TriageQuickActions({
	onStart,
	onDismiss,
	disabled,
}: TriageQuickActionsProps) {
	return (
		<ActionRow
			className={cn(
				"relative z-0 mx-auto -mb-px w-[90%] rounded-t-2xl border-b-0 border-secondary/80",
			)}
			leading={
				<>
					<Sparkles
						className="size-3.5 shrink-0 text-muted-foreground/60"
						strokeWidth={1.8}
						aria-hidden="true"
					/>
					<span className="truncate text-small font-medium tracking-[0.01em] text-muted-foreground">
						<I18nText source="aiProposedTaskStartEngageDismiss" />
					</span>
				</>
			}
			trailing={
				<>
					<ActionRowButton
						aria-label="dismissTriageProposal"
						disabled={disabled}
						onClick={onDismiss}
					>
						<X className="size-[13px] shrink-0" strokeWidth={1.8} />
						<span className="inline-flex items-center">
							<I18nText source="dismiss" />
						</span>
					</ActionRowButton>
					<ActionRowButton
						active
						aria-label="startWorkingTriageProposal"
						disabled={disabled}
						onClick={onStart}
					>
						<Play className="size-[13px] shrink-0" strokeWidth={1.8} />
						<span className="inline-flex items-center">
							<I18nText source="start" />
						</span>
					</ActionRowButton>
				</>
			}
		/>
	);
}
