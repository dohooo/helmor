import type { LucideIcon } from "lucide-react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { useI18n } from "@/lib/i18n";

/**
 * The "Optional reason / note" row used in:
 *   - GenericDeferredToolPanel (reason for Deny/Allow)
 *   - AskUserQuestionPanel (note attached to the answer)
 *
 * Wraps shadcn's `InputGroup` with a leading icon, a semi-opaque background
 * (`bg-background/70`) and softened border (`border-border/55`) so the input
 * appears elevated over the panel's card body.
 */
type InteractionOptionalInputProps = {
	icon: LucideIcon;
	placeholder: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	ariaLabel?: string;
};

export function InteractionOptionalInput({
	icon: Icon,
	placeholder,
	value,
	onChange,
	disabled = false,
	ariaLabel,
}: InteractionOptionalInputProps) {
	const { t } = useI18n();
	return (
		<div className="px-1 py-2">
			<InputGroup className="border-border/55 bg-background/70">
				<InputGroupAddon>
					<Icon aria-hidden="true" />
				</InputGroupAddon>
				<InputGroupInput
					aria-label={t(ariaLabel ?? placeholder)}
					disabled={disabled}
					placeholder={t(placeholder)}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					className="placeholder:text-muted-foreground/70"
				/>
			</InputGroup>
		</div>
	);
}
