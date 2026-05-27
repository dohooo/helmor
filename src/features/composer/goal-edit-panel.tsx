import { Check, Goal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InteractionFooter } from "./interaction/footer";
import { InteractionHeader } from "./interaction/header";
import {
	autosizeTextarea,
	INLINE_TEXTAREA_CLASS,
	UserInputCard,
} from "./user-input-panel/shared";

export type GoalEditPanelProps = {
	currentObjective: string;
	onSave: (objective: string) => void;
	onCancel: () => void;
	disabled?: boolean;
};

export function GoalEditPanel({
	currentObjective,
	onSave,
	onCancel,
	disabled,
}: GoalEditPanelProps) {
	const [objective, setObjective] = useState(currentObjective);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const trimmed = objective.trim();
	const canSave = !disabled && trimmed.length > 0;

	useEffect(() => {
		const element = textareaRef.current;
		if (!element) return;
		element.focus();
		element.setSelectionRange(element.value.length, element.value.length);
		autosizeTextarea(element);
	}, []);

	const handleSave = () => {
		if (!canSave) return;
		onSave(trimmed);
	};

	return (
		<UserInputCard>
			<InteractionHeader
				icon={Goal}
				title="Edit goal"
				description="Update the objective Codex should keep pursuing."
			/>
			<div className="px-1">
				<Textarea
					ref={textareaRef}
					value={objective}
					disabled={disabled}
					aria-label="Goal objective"
					className={INLINE_TEXTAREA_CLASS}
					onChange={(event) => {
						setObjective(event.target.value);
						autosizeTextarea(event.currentTarget);
					}}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							handleSave();
						}
					}}
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
					disabled={!canSave}
					onClick={handleSave}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>Save</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}
