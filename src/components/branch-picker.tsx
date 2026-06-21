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
import type { BranchPickerEntry, WorkspaceBranchIntent } from "@/lib/api";
import { I18nText } from "@/lib/i18n";
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
/** Pick the effective source of a branch entry under the given intent.
 *  Used by the start-page pill (decides `origin/` prefix), NOT the
 *  picker rows themselves — picker rows use one unified icon. */
export function resolveBranchSource(
	entry: { hasLocal: boolean; hasRemote: boolean },
	intent: WorkspaceBranchIntent,
): "local" | "remote" {
	if (intent === "use_branch") {
		// git DWIM is local-first when attaching; remote only when no local.
		return entry.hasLocal ? "local" : "remote";
	}
	// FromBranch: prefer the canonical published base, fall back to local.
	return entry.hasRemote ? "remote" : "local";
}

export function BranchPickerPopover({
	currentBranch,
	branches,
	entries,
	loading,
	onOpen,
	onSelect,
	align = "start",
	children,
	renderFooter,
	onCloseAutoFocus,
}: {
	currentBranch: string;
	/** Flat branch names. Used when `entries` is not provided. */
	branches?: string[];
	/** Source-tagged entries; only the `name` field is used for rendering. */
	entries?: BranchPickerEntry[];
	loading: boolean;
	onOpen: () => void;
	onSelect: (branch: string) => void;
	align?: "start" | "center" | "end";
	children: React.ReactNode;
	renderFooter?: (helpers: { close: () => void }) => React.ReactNode;
	/** Forwarded to the underlying popover content. Call `event.preventDefault()`
	 *  when the trigger is wrapped in a Tooltip — otherwise focus return reopens it. */
	onCloseAutoFocus?: (event: Event) => void;
}) {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);

	const names: string[] = entries
		? entries.map((entry) => entry.name)
		: (branches ?? []);

	return (
		<Popover
			open={open}
			onOpenChange={(next: boolean) => {
				setOpen(next);
				if (next) onOpen();
			}}
		>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<CommandPopoverContent
				align={align}
				className="w-[260px]"
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<style>{scrollbarStyle}</style>
				<div className="branch-picker">
					<CommandInput placeholder="searchBranches" />
					<CommandList className="max-h-52 px-1" style={{ marginRight: -3 }}>
						{loading && names.length === 0 ? (
							<div className="flex items-center justify-center gap-2 py-5 text-small text-muted-foreground">
								<LoaderCircle
									className="size-3.5 animate-spin"
									strokeWidth={2}
								/>
								<I18nText source="loadingBranches" />
							</div>
						) : null}
						<CommandEmpty>
							<I18nText source="noBranchesFound" />
						</CommandEmpty>
						{names.map((name) => (
							<CommandItem
								key={name}
								value={name}
								data-checked={name === currentBranch ? "true" : undefined}
								onSelect={() => {
									onSelect(name);
									setOpen(false);
								}}
								className="gap-2 rounded-lg text-small"
							>
								<GitBranch
									className="size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.8}
								/>
								<span
									className={cn(
										"min-w-0 flex-1 truncate",
										name === currentBranch && "font-semibold",
									)}
								>
									{name}
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
