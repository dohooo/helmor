import { Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";

type Props = {
	pending: boolean;
	shortcut: string | null;
	onToggle: () => void;
};

export function MiniModeToggleButton({ pending, shortcut, onToggle }: Props) {
	const label = "Resize window";

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					aria-label={label}
					disabled={pending}
					onClick={onToggle}
					variant="ghost"
					size="icon-xs"
					className="text-muted-foreground hover:text-foreground"
				>
					<Smartphone
						className="-translate-x-0.5 size-4 max-[960px]:hidden"
						strokeWidth={1.8}
					/>
					<Monitor
						className="-translate-x-0.5 hidden size-4 max-[960px]:block"
						strokeWidth={1.8}
					/>
				</Button>
			</TooltipTrigger>
			<TooltipContent
				side="bottom"
				className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
			>
				<span>{label}</span>
				{shortcut ? (
					<InlineShortcutDisplay
						hotkey={shortcut}
						className="text-background/60"
					/>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}
