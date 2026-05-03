/**
 * Inline confirm panel that pops above the composer when the user types
 * a fresh `/goal <objective>` while an active goal already exists.
 *
 * Visually mirrors `AskUserQuestionPanel`: same header / option row /
 * footer primitives + the `DeferredToolCard` inner padding wrapper. The
 * only addition is an outer floating shell because we sit above the
 * composer instead of replacing it.
 */

import { Check, Target, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DeferredToolCard } from "./deferred-tool-panel/shared";
import { InteractionFooter } from "./interaction/footer";
import { InteractionHeader } from "./interaction/header";
import { InteractionOptionRow } from "./interaction/option-row";

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
		<div className="pointer-events-auto mx-auto w-[90%] overflow-hidden rounded-2xl border border-secondary/80 bg-background shadow-lg">
			<DeferredToolCard>
				<InteractionHeader
					icon={Target}
					title="Replace goal?"
					description={
						<>
							Current:{" "}
							<span className="text-foreground">{currentObjective}</span>
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
			</DeferredToolCard>
		</div>
	);
}
