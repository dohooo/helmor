/**
 * In-place confirm panel rendered when the user types a fresh
 * `/goal <objective>` while an active goal already exists. The composer
 * outer shell takes over the body just like `UserInputPanel` /
 * `PermissionPanel` do — same `UserInputCard` wrapper, same header /
 * option row / footer primitives as `AskUserQuestionRenderer`.
 */

import { Check, Goal, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InteractionFooter } from "./interaction/footer";
import { InteractionHeader } from "./interaction/header";
import { InteractionOptionRow } from "./interaction/option-row";
import { UserInputCard } from "./user-input-panel/shared";

type Choice = "replace" | "cancel";

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
	const [choice, setChoice] = useState<Choice | null>(null);

	const handleConfirm = () => {
		if (!choice || disabled) return;
		if (choice === "replace") onReplace();
		else onCancel();
	};

	return (
		<UserInputCard>
			<InteractionHeader
				icon={Goal}
				title="Replace goal?"
				description={
					<>
						Current: <span className="text-foreground">{currentObjective}</span>
						<br />
						New: <span className="text-foreground">{newObjective}</span>
					</>
				}
			/>
			<div className="grid gap-1 px-1">
				<InteractionOptionRow
					selected={choice === "replace"}
					indicator="radio"
					label="Replace current goal"
					description="Set the new objective and start it now"
					disabled={disabled}
					onClick={() => setChoice("replace")}
				/>
				<InteractionOptionRow
					selected={choice === "cancel"}
					indicator="radio"
					label="Cancel"
					description="Keep the current goal"
					disabled={disabled}
					onClick={() => setChoice("cancel")}
				/>
			</div>
			<InteractionFooter>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={onCancel}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>Cancel</span>
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={disabled || !choice}
					onClick={handleConfirm}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>Confirm</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}
