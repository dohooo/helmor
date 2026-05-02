/**
 * Inline confirm panel that pops above the composer when the user types
 * a fresh `/goal <objective>` while an active goal already exists.
 *
 * UI primitives are borrowed from the AskUserQuestion panel (purely
 * visual reuse — `InteractionOptionRow` + `InteractionHeader`). The
 * actual flow is local: no JSON-RPC, no deferred-tool plumbing. We
 * just intercept the submit, show the user a choice, and either drop
 * the prompt or let it through.
 */

import { Target } from "lucide-react";
import { InteractionHeader } from "./interaction/header";
import { InteractionOptionRow } from "./interaction/option-row";

export type GoalReplaceConfirmProps = {
	currentObjective: string;
	newObjective: string;
	onReplace: () => void;
	onCancel: () => void;
	disabled?: boolean;
};

export function GoalReplaceConfirm({
	currentObjective,
	newObjective,
	onReplace,
	onCancel,
	disabled,
}: GoalReplaceConfirmProps) {
	return (
		<div className="pointer-events-auto mx-auto w-[90%] overflow-hidden rounded-md border border-secondary/80 bg-background px-3 py-3 shadow-sm">
			<InteractionHeader
				icon={Target}
				title="Replace goal?"
				description={
					<>
						Current: <span className="text-foreground">{currentObjective}</span>
						<br />
						New: <span className="text-foreground">{newObjective}</span>
					</>
				}
			/>
			<div className="mt-1 grid gap-1 px-1">
				<InteractionOptionRow
					selected={false}
					indicator="radio"
					label="Replace current goal"
					description="Set the new objective and start it now"
					disabled={disabled}
					onClick={onReplace}
				/>
				<InteractionOptionRow
					selected={false}
					indicator="radio"
					label="Cancel"
					description="Keep the current goal"
					disabled={disabled}
					onClick={onCancel}
				/>
			</div>
		</div>
	);
}
