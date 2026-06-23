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
import { useI18n } from "@/lib/i18n";
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
	const { t } = useI18n();
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
				title="replaceGoal"
				description={
					<>
						{t("current2")}{" "}
						<span className="text-foreground">{currentObjective}</span>
						<br />
						{t("new")} <span className="text-foreground">{newObjective}</span>
					</>
				}
			/>
			<div className="grid gap-1 px-1">
				<InteractionOptionRow
					selected={choice === "replace"}
					indicator="radio"
					label="replaceCurrentGoal"
					description="setNewObjectiveStartNow"
					disabled={disabled}
					onClick={() => setChoice("replace")}
				/>
				<InteractionOptionRow
					selected={choice === "cancel"}
					indicator="radio"
					label="cancel"
					description="keepCurrentGoal"
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
					<span>{t("cancel")}</span>
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={disabled || !choice}
					onClick={handleConfirm}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>{t("confirm")}</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}
