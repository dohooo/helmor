import { cn } from "@/lib/utils";
import {
	formatResetsAt,
	formatTokens,
	type RateLimitWindowDisplay,
	type RingTier,
	ringTier,
} from "./parse";

/** Top-of-card "Context — 12.4k/1.0M · 8%" row. Pass `used`/`max` as
 *  `null` when window size is unknown (fresh session placeholder) — only
 *  the percentage shows on the right. */
export function UsageHeader({
	used,
	max,
	percentage,
}: {
	used: number | null;
	max: number | null;
	percentage: number;
}) {
	const hasTokens = used !== null && max !== null;
	return (
		<div className="flex items-center justify-between">
			<div className="text-[14px] font-semibold text-foreground">Context</div>
			<div className="text-[12px] tabular-nums text-muted-foreground">
				{hasTokens ? (
					<>
						{formatTokens(used)}/{formatTokens(max)}
						<span className="mx-1.5 opacity-60">·</span>
					</>
				) : null}
				<span className="text-foreground">{formatPercentage(percentage)}</span>
			</div>
		</div>
	);
}

/** Compact percentage: 1 decimal under 10%, integer above. Strips ".0". */
function formatPercentage(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0%";
	if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
	return `${Math.round(value)}%`;
}

/** Full-width progress bar tinted by ring tier. */
export function UsageBar({
	percentage,
	tier,
}: {
	percentage: number;
	tier: RingTier;
}) {
	const barColor =
		tier === "danger"
			? "bg-destructive"
			: tier === "warning"
				? "bg-amber-500"
				: "bg-foreground/70";
	return (
		<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
			<div
				className={cn("h-full transition-[width]", barColor)}
				style={{ width: `${Math.min(100, percentage)}%` }}
			/>
		</div>
	);
}

/** Thin divider between sub-sections inside the card. */
export function Divider() {
	return <div className="h-px w-full bg-border/60" />;
}

/** One rate-limit row: label + "X% left" + thin bar + reset time.
 *  Tier color tracks `usedPercent` (≥60 amber, ≥80 destructive) so the
 *  bar that visually represents *remaining* still warns when little is
 *  left — i.e. when usage is high. */
export function LimitRow({ window }: { window: RateLimitWindowDisplay }) {
	const muted = window.expired;
	const tier = ringTier(window.usedPercent);
	const barColor =
		tier === "danger"
			? "bg-destructive"
			: tier === "warning"
				? "bg-amber-500"
				: "bg-foreground/70";
	return (
		<div className={cn("flex flex-col gap-1", muted && "opacity-60")}>
			<div className="flex items-center justify-between text-[12px]">
				<span className="text-foreground">{window.label ?? "Limit"}</span>
				<span className="font-medium tabular-nums text-foreground">
					{Math.round(window.leftPercent)}% left
				</span>
			</div>
			<div className="h-1 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={cn("h-full transition-[width]", barColor)}
					style={{ width: `${window.leftPercent}%` }}
				/>
			</div>
			{window.resetsAt !== null ? (
				<div className="text-[11px] text-muted-foreground">
					{window.expired ? "Pending refresh — " : "Resets "}
					{formatResetsAt(window.resetsAt)}
				</div>
			) : null}
		</div>
	);
}

/** Claude rich breakdown: muted name + percentage per row, no dividers.
 *  Matches the original context-usage card style. */
export function CategoryList({
	categories,
	maxTokens,
}: {
	categories: ReadonlyArray<{ name: string; tokens: number }>;
	maxTokens: number;
}) {
	// Largest first — biggest consumer leads the eye.
	const sorted = [...categories].sort((a, b) => b.tokens - a.tokens);
	return (
		<div className="flex flex-col gap-1.5">
			{sorted.map((c) => (
				<div
					key={c.name}
					className="flex items-center justify-between text-[12px]"
				>
					<span className="truncate text-muted-foreground">{c.name}</span>
					<span className="tabular-nums text-muted-foreground">
						{formatCategoryPercent(c.tokens, maxTokens)}
					</span>
				</div>
			))}
		</div>
	);
}

function formatCategoryPercent(tokens: number, maxTokens: number): string {
	if (!(maxTokens > 0)) return "—";
	const pct = (tokens / maxTokens) * 100;
	if (pct <= 0) return "0.0%";
	return `${pct.toFixed(1)}%`;
}

/** Footer note shown when the Claude session has auto-compact enabled. */
export function AutoCompactNote() {
	return (
		<div className="text-[11px] text-muted-foreground">
			Auto-compacts older turns when the window fills.
		</div>
	);
}
