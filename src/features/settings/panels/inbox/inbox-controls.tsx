// Selectors used inside the inbox settings panel: repo picker, scope
// multi-select (with a special "all" sentinel), forge-label multi-select
// (driven by the per-repo labels query), and a generic single-value
// dropdown. All purely presentational — state lives in the parent panel.
import { ChevronDown, X } from "lucide-react";
import { useMemo } from "react";
import { GithubBrandIcon } from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import type { ForgeLabelOption, RepositoryCreateOption } from "@/lib/api";
import { initialsFor } from "@/lib/initials";
import { cn } from "@/lib/utils";

export type Option<T extends string> = {
	value: T;
	label: string;
};

export function ScopeMultiSelect<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T[];
	options: Option<T>[];
	onChange: (value: T[]) => void;
}) {
	const allValue = options.find((option) => option.value === "all")?.value;
	const fallbackValue = allValue ?? options[0]?.value;
	const normalizeValues = (values: T[]) => {
		const validValues = values.filter((item) =>
			options.some((option) => option.value === item),
		);
		if (allValue && validValues.includes(allValue)) {
			return [allValue];
		}
		if (validValues.length > 0) {
			return Array.from(new Set(validValues));
		}
		return fallbackValue ? [fallbackValue] : [];
	};
	const selectedValues = normalizeValues(value);
	const selected = options.filter((option) =>
		selectedValues.includes(option.value),
	);
	const toggleValue = (nextValue: T) => {
		if (allValue && nextValue === allValue) {
			onChange([allValue]);
			return;
		}
		const hasValue = selectedValues.includes(nextValue);
		const nextValues = hasValue
			? selectedValues.filter((item) => item !== nextValue)
			: [...selectedValues.filter((item) => item !== allValue), nextValue];
		onChange(normalizeValues(nextValues));
	};
	return (
		<Popover>
			<PopoverTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					className={cn(
						"flex min-h-9 w-[280px] cursor-interactive items-center justify-between gap-2 rounded-lg border border-input bg-muted/20 px-2 py-1 text-left transition-colors",
						"hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
					)}
				>
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
						{selected.map((option) => (
							<Badge
								key={option.value}
								variant="outline"
								className="h-6 gap-1 rounded-md pr-1 text-[11px]"
								onClick={(event) => event.stopPropagation()}
							>
								{option.label}
								<button
									type="button"
									aria-label={`Remove ${option.label}`}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										toggleValue(option.value);
									}}
									className="inline-flex size-4 cursor-interactive items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									<X className="size-3" strokeWidth={2} />
								</button>
							</Badge>
						))}
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</div>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[280px] p-1.5">
				<Command>
					<CommandInput placeholder="Search scopes" />
					<CommandList>
						<CommandEmpty>No scopes found.</CommandEmpty>
						<CommandGroup>
							{options.map((option) => {
								const checked = selectedValues.includes(option.value);
								return (
									<CommandItem
										key={option.value}
										value={option.label}
										data-checked={checked}
										onSelect={() => toggleValue(option.value)}
									>
										{option.label}
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

export function LabelMultiSelect({
	value,
	options,
	loading,
	onChange,
}: {
	value: string[];
	options: ForgeLabelOption[];
	loading: boolean;
	onChange: (value: string[]) => void;
}) {
	const optionMap = useMemo(
		() => new Map(options.map((option) => [option.name, option])),
		[options],
	);
	const mergedOptions = useMemo(() => {
		const selectedOnly = value
			.filter((label) => !optionMap.has(label))
			.map((name) => ({ name, color: null, description: null }));
		return [...selectedOnly, ...options];
	}, [optionMap, options, value]);
	const toggleValue = (nextValue: string) => {
		onChange(
			value.includes(nextValue)
				? value.filter((item) => item !== nextValue)
				: [...value, nextValue],
		);
	};
	return (
		<Popover>
			<PopoverTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					className={cn(
						"flex min-h-9 w-[280px] cursor-interactive items-center justify-between gap-2 rounded-lg border border-input bg-muted/20 px-2 py-1 text-left transition-colors",
						"hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
					)}
				>
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
						{value.length > 0 ? (
							value.map((label) => (
								<Badge
									key={label}
									variant="outline"
									className="h-6 gap-1 rounded-md pr-1 text-[11px]"
									onClick={(event) => event.stopPropagation()}
								>
									<LabelColorDot color={optionMap.get(label)?.color} />
									{label}
									<button
										type="button"
										aria-label={`Remove ${label}`}
										onClick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											toggleValue(label);
										}}
										className="inline-flex size-4 cursor-interactive items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
									>
										<X className="size-3" strokeWidth={2} />
									</button>
								</Badge>
							))
						) : (
							<span className="px-1 text-[12px] text-muted-foreground">
								{loading ? "Loading labels" : "Select labels"}
							</span>
						)}
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</div>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[280px] p-1.5">
				<Command>
					<CommandInput placeholder="Search labels" />
					<CommandList>
						<CommandEmpty>
							{loading ? "Loading labels..." : "No labels found."}
						</CommandEmpty>
						<CommandGroup>
							{mergedOptions.map((option) => {
								const checked = value.includes(option.name);
								return (
									<CommandItem
										key={option.name}
										value={option.name}
										data-checked={checked}
										onSelect={() => toggleValue(option.name)}
									>
										<LabelColorDot color={option.color} />
										<span className="truncate">{option.name}</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

export function LabelColorDot({ color }: { color?: string | null }) {
	if (!color) return null;
	return (
		<span
			className="size-2 shrink-0 rounded-full"
			style={{ backgroundColor: `#${color}` }}
		/>
	);
}

export function SettingsSelect<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: Option<T>[];
	onChange: (value: T) => void;
}) {
	const selected =
		options.find((option) => option.value === value) ?? options[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					className="h-9 w-[180px] cursor-interactive justify-between gap-2 px-3 text-[13px]"
				>
					<span className="truncate">{selected.label}</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-[var(--radix-dropdown-menu-trigger-width)]"
			>
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						onSelect={() => onChange(option.value)}
						className="cursor-interactive text-[13px]"
					>
						{option.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function RepoPicker({
	repositories,
	selected,
	onSelect,
}: {
	repositories: ReadonlyArray<{
		repository: RepositoryCreateOption;
		repoFilter: string;
	}>;
	selected: RepositoryCreateOption | null;
	onSelect: (repoFilter: string) => void;
}) {
	const selectedEntry =
		repositories.find((entry) => entry.repository.id === selected?.id) ?? null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					disabled={repositories.length === 0}
					className="h-10 w-[280px] cursor-interactive justify-between gap-2 px-3 text-[13px]"
				>
					<span className="flex min-w-0 items-center gap-2">
						{selected ? (
							<RepoAvatar repo={selected} />
						) : (
							<GithubBrandIcon size={16} />
						)}
						<span className="min-w-0 truncate font-medium">
							{selected ? selected.name : "Select repo"}
						</span>
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-[var(--radix-dropdown-menu-trigger-width)]"
			>
				{repositories.map((entry) => (
					<DropdownMenuItem
						key={entry.repoFilter}
						onSelect={() => onSelect(entry.repoFilter)}
						className="cursor-interactive gap-2 text-[13px]"
					>
						<RepoAvatar repo={entry.repository} />
						<span className="min-w-0 flex-1 truncate">
							{entry.repository.name}
						</span>
						{selectedEntry?.repoFilter === entry.repoFilter ? (
							<span className="size-1.5 shrink-0 rounded-full bg-primary" />
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function RepoAvatar({ repo }: { repo: RepositoryCreateOption }) {
	return (
		<CachedAvatar
			src={repo.repoIconSrc ?? undefined}
			alt={repo.name}
			fallback={repo.repoInitials ?? initialsFor(repo.name)}
			className="size-5 shrink-0 rounded-md"
			fallbackClassName="rounded-md text-[10px]"
		/>
	);
}
