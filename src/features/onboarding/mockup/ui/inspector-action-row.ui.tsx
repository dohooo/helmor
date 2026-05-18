import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActionStatusKind } from "./shared";

/**
 * Pure-UI status indicator (success / running / failure / pending) used
 * inside Action rows in the Actions section. Matches the real `StatusIcon`
 * defined inside `actions.tsx`.
 */
export function InspectorStatusIconUI({
	status,
}: {
	status: ActionStatusKind;
}) {
	if (status === "success") {
		return (
			<CheckIcon
				aria-label="Passed"
				className="size-3 shrink-0 text-chart-2"
				strokeWidth={2.2}
			/>
		);
	}
	const label =
		status === "running"
			? "Running"
			: status === "failure"
				? "Failed"
				: "Pending";
	const color =
		status === "running"
			? "rgb(245, 158, 11)"
			: status === "failure"
				? "rgb(207, 34, 46)"
				: undefined;
	return (
		<span
			aria-label={label}
			className="inline-flex size-3 shrink-0 items-center justify-center rounded-full border border-current text-muted-foreground"
			style={color ? { color } : undefined}
		>
			<span
				className={cn(
					"size-1.5 rounded-full",
					status === "pending" && "bg-muted-foreground",
				)}
				style={color ? { backgroundColor: color } : undefined}
			/>
		</span>
	);
}

/**
 * Pure-UI single Action row — status icon + label + optional right-aligned
 * action link. Mirrors the row body inside `ActionsSection`.
 */
export function InspectorActionRowUI({
	label,
	status,
	actionLabel,
	onActionClick,
}: {
	label: string;
	status: ActionStatusKind;
	actionLabel?: string;
	onActionClick?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60">
			<InspectorStatusIconUI status={status} />
			<span className="truncate">{label}</span>
			{actionLabel ? (
				<button
					type="button"
					onClick={onActionClick}
					className="ml-auto shrink-0 cursor-interactive text-[10.5px] text-primary transition-colors hover:text-primary/80"
				>
					{actionLabel}
				</button>
			) : null}
		</div>
	);
}

/** Small uppercase subtitle ("Git", "Review", "Deployments"). */
export function InspectorActionGroupTitleUI({
	children,
}: {
	children: string;
}) {
	return (
		<div className="px-2.5 pb-1 pt-2.5">
			<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
				{children}
			</span>
		</div>
	);
}
