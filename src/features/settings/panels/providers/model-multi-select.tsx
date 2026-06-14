import { ChevronDown, X } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type MultiSelectOption = { id: string; label: string };

// Above this, the trigger collapses to "+N more".
const MAX_VISIBLE_CHIPS = 5;

export function groupHeading(option: MultiSelectOption): string {
	const sep = option.label.indexOf(" · ");
	if (sep > 0) return option.label.slice(0, sep);
	return option.id.split("/")[0] ?? "Models";
}

// Plain substring match: every whitespace-separated token must appear in the
// model's label or id. Replaces cmdk's default fuzzy (subsequence) scorer, which
// let "opencode go" match unrelated models. Returns 0 to hide the item.
export function scoreModel(value: string, search: string): number {
	const query = search.trim().toLowerCase();
	if (!query) return 1;
	const haystack = value.toLowerCase();
	for (const token of query.split(/\s+/)) {
		if (!haystack.includes(token)) return 0;
	}
	return 1;
}

export function ModelMultiSelect({
	enabledIds,
	enabledSet,
	available,
	onToggle,
	onClear,
	loading,
	grouped = true,
	triggerClassName,
}: {
	enabledIds: string[];
	enabledSet: Set<string>;
	available: MultiSelectOption[];
	onToggle: (id: string) => void;
	/** Unselect all — clears the entire selection, ignoring the search. */
	onClear: () => void;
	loading: boolean;
	/** Group by sub-provider (OpenCode). Off → flat list (Cursor has no groups). */
	grouped?: boolean;
	triggerClassName?: string;
}) {
	// Render picks in user-saved order; popup list keeps catalog order.
	const enabled = enabledIds.map(
		(id) => available.find((m) => m.id === id) ?? { id, label: id },
	);
	const visibleChips = enabled.slice(0, MAX_VISIBLE_CHIPS);
	const overflow = enabled.length - visibleChips.length;

	// Group the catalog by sub-provider so many models stay navigable.
	const groups = useMemo(() => {
		if (!grouped) return null;
		const map = new Map<string, MultiSelectOption[]>();
		for (const model of available) {
			const heading = groupHeading(model);
			const bucket = map.get(heading);
			if (bucket) bucket.push(model);
			else map.set(heading, [model]);
		}
		return [...map.entries()];
	}, [available, grouped]);

	const renderItem = (model: MultiSelectOption) => {
		// No real name → show just the id (avoid two identical lines).
		const name = model.label.trim();
		const hasName = name.length > 0 && name !== model.id;
		return (
			<CommandItem
				key={model.id}
				value={`${model.label} ${model.id}`}
				data-checked={enabledSet.has(model.id)}
				onSelect={() => onToggle(model.id)}
				className="items-start"
			>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					{hasName ? (
						<>
							<span className="text-ui leading-tight">{model.label}</span>
							<span className="font-mono text-micro leading-tight text-muted-foreground">
								{model.id}
							</span>
						</>
					) : (
						<span className="font-mono text-ui leading-tight">{model.id}</span>
					)}
				</div>
			</CommandItem>
		);
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					className={cn(
						"flex min-h-9 max-w-full cursor-interactive items-center justify-between gap-2 rounded-lg border border-input bg-muted/20 px-2 py-1 text-left transition-colors",
						"hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
						triggerClassName ?? "w-[440px]",
					)}
				>
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
						{enabled.length === 0 ? (
							<span className="px-1 text-small text-muted-foreground">
								{loading ? "Loading…" : "No models picked"}
							</span>
						) : (
							<>
								{visibleChips.map((model) => (
									<Badge
										key={model.id}
										variant="outline"
										className="h-6 max-w-full gap-1 rounded-md pr-1 text-mini"
										onClick={(event) => event.stopPropagation()}
									>
										<span className="truncate">{model.label}</span>
										<button
											type="button"
											aria-label={`Remove ${model.label}`}
											onClick={(event) => {
												event.preventDefault();
												event.stopPropagation();
												onToggle(model.id);
											}}
											className="inline-flex size-4 shrink-0 cursor-interactive items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
										>
											<X className="size-3" strokeWidth={2} />
										</button>
									</Badge>
								))}
								{overflow > 0 ? (
									<span className="px-1 text-mini text-muted-foreground">
										+{overflow} more
									</span>
								) : null}
							</>
						)}
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</div>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[440px] max-w-[90vw] p-1.5">
				<Command filter={scoreModel}>
					<CommandInput placeholder="Search models" />
					{enabledIds.length > 0 ? (
						<div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-1">
							<span className="text-mini text-muted-foreground">
								{enabledIds.length} selected
							</span>
							<Button type="button" variant="ghost" size="xs" onClick={onClear}>
								Unselect all
							</Button>
						</div>
					) : null}
					<CommandList className="max-h-[min(60vh,420px)]">
						<CommandEmpty>
							{available.length === 0
								? loading
									? "Loading models…"
									: "No cached models yet — click Refresh."
								: "No models found."}
						</CommandEmpty>
						{groups ? (
							groups.map(([heading, models]) => (
								<CommandGroup key={heading} heading={heading}>
									{models.map(renderItem)}
								</CommandGroup>
							))
						) : (
							<CommandGroup>{available.map(renderItem)}</CommandGroup>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
