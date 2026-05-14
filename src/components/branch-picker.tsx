import { GitBranch, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { CommandPopoverContent } from "@/components/ui/command-popover";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Scoped thin scrollbar: 3px, sits in the right padding gap.
// Uses high-specificity selector to override the global 8px scrollbar.
const scrollbarStyle = `
.branch-picker [data-slot="command-list"]::-webkit-scrollbar { width: 3px; background: transparent; }
.branch-picker [data-slot="command-list"]::-webkit-scrollbar-track { background: transparent; }
.branch-picker [data-slot="command-list"]::-webkit-scrollbar-thumb { border-radius: 999px; background: color-mix(in oklch, var(--foreground) 18%, transparent); }
.branch-picker [data-slot="command-list"] { scrollbar-width: thin; }
`;

/**
 * Shared branch picker popover used in both the workspace header
 * and repository settings. Renders a searchable list of branches.
 *
 * Pass the trigger element as `children` — it will be wrapped in
 * a `PopoverTrigger`. The optional `footer` slot renders a sticky
 * row below the list (e.g. "Create and checkout new branch...").
 * `renderFooter` receives a `close` helper so the footer item can
 * dismiss the popover before opening a follow-up dialog.
 */
export function BranchPickerPopover({
	currentBranch,
	branches,
	loading,
	onOpen,
	onSelect,
	align = "start",
	children,
	renderFooter,
}: {
	currentBranch: string;
	branches: string[];
	loading: boolean;
	onOpen: () => void;
	onSelect: (branch: string) => void;
	align?: "start" | "center" | "end";
	children: React.ReactNode;
	renderFooter?: (helpers: { close: () => void }) => React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);

	return (
		<Popover
			open={open}
			onOpenChange={(next: boolean) => {
				setOpen(next);
				if (next) onOpen();
			}}
		>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<CommandPopoverContent align={align} className="w-[260px]">
				<style>{scrollbarStyle}</style>
				<div className="branch-picker">
					<CommandInput placeholder="Search branches..." />
					<CommandList className="max-h-52 px-1" style={{ marginRight: -3 }}>
						{loading && branches.length === 0 ? (
							<div className="flex items-center justify-center gap-2 py-5 text-[12px] text-muted-foreground">
								<LoaderCircle
									className="size-3.5 animate-spin"
									strokeWidth={2}
								/>
								Loading branches...
							</div>
						) : null}
						<CommandEmpty>No branches found</CommandEmpty>
						{branches.map((branch) => (
							<CommandItem
								key={branch}
								value={branch}
								data-checked={branch === currentBranch ? "true" : undefined}
								onSelect={() => {
									onSelect(branch);
									setOpen(false);
								}}
								className="gap-2 rounded-lg text-[12px]"
							>
								<GitBranch
									className="size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.8}
								/>
								<span
									className={cn(
										"min-w-0 flex-1 truncate",
										branch === currentBranch && "font-semibold",
									)}
								>
									{branch}
								</span>
							</CommandItem>
						))}
					</CommandList>
					{renderFooter ? (
						<div className="border-border/40 border-t px-1 pt-1">
							{renderFooter({ close })}
						</div>
					) : null}
				</div>
			</CommandPopoverContent>
		</Popover>
	);
}
