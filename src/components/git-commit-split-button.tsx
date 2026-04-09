import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
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
			? "bg-app-foreground/8 text-app-muted disabled:cursor-not-allowed disabled:opacity-60"
			: "bg-app-accent text-app-foreground hover:bg-app-accent-strong hover:text-app-foreground",
	);

	const dividerClasses = cn(
		"w-px shrink-0 self-stretch",
		disabled ? "bg-app-muted/55" : "bg-app-foreground/35",
	);

	const triggerClasses = cn(
		"inline-flex h-full shrink-0 items-center rounded-r-[4px] px-1.5 py-1 transition-colors",
		disabled
			? "text-app-muted disabled:cursor-not-allowed disabled:opacity-60"
			: "text-app-foreground hover:bg-app-accent-strong hover:text-app-foreground",
	);

	const hasChanges = !disabled;

	return (
		<DropdownMenu
			open={hasChanges && isOpen}
			onOpenChange={(open) => onOpenChange?.(open)}
		>
			<div
				className={cn(
					"ml-auto inline-flex h-6 items-stretch rounded-[4px] border",
					disabled ? "border-app-border" : "border-app-accent",
				)}
			>
				<button
					type="button"
					disabled={disabled}
					aria-label="Commit current changes"
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
				</button>
				<span className={dividerClasses} />
				{/* NOTE: `asChild` isn't supported by this project's
				 * DropdownMenuTrigger wrapper. This component is currently
				 * unused and kept only as a WIP reference. */}
				<DropdownMenuTrigger>
					<button
						type="button"
						disabled={disabled}
						aria-label="Git section more actions"
						className={triggerClasses}
						onMouseEnter={() => {
							if (!hasChanges) return;
							onOpenChange?.(true);
						}}
					>
						<ChevronDown className="size-3 flex-none" strokeWidth={2.2} />
					</button>
				</DropdownMenuTrigger>
			</div>
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
