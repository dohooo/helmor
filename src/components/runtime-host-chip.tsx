// Phase 22d: small inline chip surfacing the workspace's bound
// remote runtime. Rendered in the sidebar row, the workspace panel
// header, and inline inside confirmation modals — anywhere the user
// would benefit from "this workspace runs on dev.box, not your
// laptop". `null` / `"local"` collapses to no chip (the local
// runtime is the default and doesn't need labelling).

import { Server } from "lucide-react";
import { cn } from "@/lib/utils";

export type RuntimeHostChipProps = {
	runtimeName?: string | null;
	/**
	 * Style variant tuned for the consumer's density:
	 * - `inline`  → sidebar / header (tight, small text).
	 * - `compact` → confirm-modal body (slightly larger, fits text
	 *   density of surrounding sentence).
	 */
	variant?: "inline" | "compact";
	className?: string;
};

/**
 * True when the binding is a *real* remote runtime — i.e. not absent
 * and not the literal `"local"` string. Centralised here so the
 * sidebar / header / modal call sites stay consistent if the
 * "local" sentinel ever changes shape.
 */
export function isRemoteRuntime(runtimeName?: string | null): boolean {
	if (!runtimeName) return false;
	const trimmed = runtimeName.trim();
	return trimmed !== "" && trimmed !== "local";
}

export function RuntimeHostChip({
	runtimeName,
	variant = "inline",
	className,
}: RuntimeHostChipProps) {
	if (!isRemoteRuntime(runtimeName)) return null;
	const sizing =
		variant === "compact"
			? "h-5 px-1.5 text-[11px] gap-1"
			: "h-4 px-1 text-[10px] gap-0.5";
	const iconSize = variant === "compact" ? "size-3" : "size-2.5";
	return (
		<span
			aria-label={`Workspace runtime: ${runtimeName}`}
			title={`Workspace runs on ${runtimeName}`}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full border border-border/50 bg-muted/60 font-mono uppercase tracking-wide text-muted-foreground",
				sizing,
				className,
			)}
		>
			<Server className={iconSize} strokeWidth={1.8} />
			<span className="lowercase">{runtimeName}</span>
		</span>
	);
}
