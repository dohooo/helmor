import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Shared step-switcher tabs for interaction panels with multiple steps
 * (AskUserQuestion questions, FormElicitation fields). Renders nothing
 * when there's only one step.
 *
 * Incomplete steps dim to 55% opacity; required steps get a `*` suffix.
 * The active step's highlight is delegated to shadcn `TabsTrigger` defaults.
 */
export type InteractionStepTabItem = {
	key: string;
	label: ReactNode;
	/** Whether the step is answered / validated. Incomplete steps dim out. */
	complete: boolean;
	/** When true, append a `*` suffix to the label. */
	required?: boolean;
};

type InteractionStepTabsProps = {
	items: InteractionStepTabItem[];
	value: string;
	onChange: (key: string) => void;
	disabled?: boolean;
};

export function InteractionStepTabs({
	items,
	value,
	onChange,
	disabled = false,
}: InteractionStepTabsProps) {
	if (items.length <= 1) return null;

	return (
		<div className="px-1 pb-2">
			<Tabs value={value} onValueChange={onChange}>
				<TabsList className="h-auto flex-wrap p-0.5">
					{items.map((item) => (
						<TabsTrigger
							key={item.key}
							value={item.key}
							disabled={disabled}
							className={cn(
								"h-6 px-2 text-small",
								!item.complete && "opacity-55",
							)}
						>
							{item.required ? (
								<span>
									{item.label}
									<span className="ml-0.5 text-muted-foreground">*</span>
								</span>
							) : (
								item.label
							)}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
		</div>
	);
}
