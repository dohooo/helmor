import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "./ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface CommitSplitButtonProps {
	disabled: boolean;
	isOpen: boolean;
	children: React.ReactNode;
	mainLabel?: string;
	onMainAction?: () => void;
	onOpenChange?: (open: boolean) => void;
}

export function CommitSplitButton({
	disabled,
	isOpen,
	children,
	mainLabel = "Commit",
	onMainAction = () => {},
	onOpenChange,
}: CommitSplitButtonProps) {
	const commitButtonClasses = cn(
		"inline-flex h-full shrink-0 items-center gap-1 rounded-l-[4px] px-2 py-1 text-[11px] font-medium leading-none tracking-[0.01em] transition-colors",
		disabled
			? "bg-muted text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
			: "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
	);

	const dividerClasses = cn(
		"w-px shrink-0 self-stretch",
		disabled ? "bg-border/80" : "bg-primary-foreground/20",
	);

	const triggerClasses = cn(
		"inline-flex h-full shrink-0 items-center rounded-r-[4px] px-1.5 py-1 transition-colors",
		disabled
			? "text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
			: "text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
	);

	const hasChanges = !disabled;

	return (
		<DropdownMenu
			open={hasChanges && isOpen}
			onOpenChange={(open) => onOpenChange?.(open)}
		>
			<ButtonGroup
				className={cn(
					"ml-auto h-6 items-stretch rounded-[4px] border [&>[data-slot=button]]:h-full [&>[data-slot=button]]:rounded-none [&>[data-slot=button]:first-child]:rounded-l-[4px] [&>[data-slot=button]:last-child]:rounded-r-[4px]",
					disabled ? "border-border" : "border-primary",
				)}
			>
				<Button
					type="button"
					disabled={disabled}
					aria-label="Commit current changes"
					variant="ghost"
					size="xs"
					className={commitButtonClasses}
					onMouseEnter={() => {
						if (!hasChanges) return;
						onOpenChange?.(true);
					}}
					onClick={() => {
						if (!hasChanges) return;
						onMainAction();
					}}
				>
					<span>{mainLabel}</span>
				</Button>
				<ButtonGroupSeparator className={dividerClasses} />
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						disabled={disabled}
						aria-label="Git section more actions"
						variant="ghost"
						size="xs"
						className={triggerClasses}
						onMouseEnter={() => {
							if (!hasChanges) return;
							onOpenChange?.(true);
						}}
					>
						<ChevronDown className="size-3 flex-none" strokeWidth={2.2} />
					</Button>
				</DropdownMenuTrigger>
			</ButtonGroup>
			<DropdownMenuContent
				align="end"
				side="bottom"
				sideOffset={4}
				onMouseEnter={() => {
					if (!hasChanges) return;
					onOpenChange?.(true);
				}}
				onMouseLeave={() => onOpenChange?.(false)}
				className="w-fit min-w-0 p-1"
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default CommitSplitButton;
