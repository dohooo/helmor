import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import type { AutomationSchedule } from "@/lib/api";
import { cn } from "@/lib/utils";
import { scheduleSummary, WEEKDAY_NAMES } from "./schedule";

function timeOf(value: AutomationSchedule): string {
	if (value.kind === "daily" || value.kind === "weekly") return value.time;
	return "09:00";
}

/** Compact dropdown control inside the picker (weekday / unit). */
function InlineSelect<T extends string | number>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	const active = options.find((option) => option.value === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="xs"
					className="gap-1 font-normal"
				>
					{active?.label ?? String(value)}
					<ChevronDown className="size-3 text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
				<DropdownMenuRadioGroup
					value={String(value)}
					onValueChange={(next) => {
						const match = options.find(
							(option) => String(option.value) === next,
						);
						if (match) onChange(match.value);
					}}
				>
					{options.map((option) => (
						<DropdownMenuRadioItem
							key={String(option.value)}
							value={String(option.value)}
						>
							{option.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function IntervalOption({
	label,
	active,
	onSelect,
	children,
}: {
	label: string;
	active: boolean;
	onSelect: () => void;
	children?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1",
				active && "bg-muted/60",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex shrink-0 cursor-pointer items-center gap-2 text-left text-ui text-foreground"
			>
				<Check
					className={cn(
						"size-3.5 shrink-0",
						active ? "opacity-100" : "opacity-0",
					)}
				/>
				<span>{label}</span>
			</button>
			{children}
		</div>
	);
}

const TIME_INPUT_CLASSES = "h-6 w-fit rounded-md px-1.5 text-small";

/** Shared interval picker — used by the create dialog footer and the detail
 *  sidebar. Renders the current schedule as a compact trigger; the popover
 *  offers the four supported cadences with inline parameter controls. */
export function IntervalPicker({
	value,
	onChange,
	className,
	align = "start",
}: {
	value: AutomationSchedule;
	onChange: (schedule: AutomationSchedule) => void;
	className?: string;
	align?: "start" | "end";
}) {
	const setKind = (kind: AutomationSchedule["kind"]) => {
		if (kind === value.kind) return;
		switch (kind) {
			case "hourly":
				onChange({ kind: "hourly" });
				break;
			case "daily":
				onChange({ kind: "daily", time: timeOf(value) });
				break;
			case "weekly":
				onChange({ kind: "weekly", weekday: 1, time: timeOf(value) });
				break;
			case "every":
				onChange({ kind: "every", amount: 15, unit: "minutes" });
				break;
		}
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className={cn(
						"max-w-56 justify-between gap-1.5 font-normal",
						className,
					)}
				>
					<span className="truncate">{scheduleSummary(value)}</span>
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align={align} className="w-80 p-1">
				<IntervalOption
					label="Hourly"
					active={value.kind === "hourly"}
					onSelect={() => setKind("hourly")}
				/>
				<IntervalOption
					label="Daily at"
					active={value.kind === "daily"}
					onSelect={() => setKind("daily")}
				>
					{value.kind === "daily" ? (
						<Input
							type="time"
							aria-label="Daily run time"
							value={value.time}
							onChange={(event) => {
								if (event.target.value) {
									onChange({ kind: "daily", time: event.target.value });
								}
							}}
							className={TIME_INPUT_CLASSES}
						/>
					) : null}
				</IntervalOption>
				<IntervalOption
					label="Weekly on"
					active={value.kind === "weekly"}
					onSelect={() => setKind("weekly")}
				>
					{value.kind === "weekly" ? (
						<>
							<InlineSelect
								value={value.weekday}
								options={WEEKDAY_NAMES.map((name, weekday) => ({
									value: weekday,
									label: name,
								}))}
								onChange={(weekday) => onChange({ ...value, weekday })}
							/>
							<span className="text-ui text-muted-foreground">at</span>
							<Input
								type="time"
								aria-label="Weekly run time"
								value={value.time}
								onChange={(event) => {
									if (event.target.value) {
										onChange({ ...value, time: event.target.value });
									}
								}}
								className={TIME_INPUT_CLASSES}
							/>
						</>
					) : null}
				</IntervalOption>
				<IntervalOption
					label="Every"
					active={value.kind === "every"}
					onSelect={() => setKind("every")}
				>
					{value.kind === "every" ? (
						<>
							<Input
								type="number"
								min={1}
								aria-label="Interval amount"
								value={value.amount}
								onChange={(event) => {
									const amount = Number.parseInt(event.target.value, 10);
									if (Number.isFinite(amount) && amount >= 1) {
										onChange({ ...value, amount });
									}
								}}
								className="h-6 w-14 rounded-md px-1.5 text-small"
							/>
							<InlineSelect
								value={value.unit}
								options={[
									{ value: "minutes" as const, label: "minutes" },
									{ value: "hours" as const, label: "hours" },
								]}
								onChange={(unit) => onChange({ ...value, unit })}
							/>
						</>
					) : null}
				</IntervalOption>
			</PopoverContent>
		</Popover>
	);
}
