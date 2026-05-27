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
	// Prominent "this runs remotely" treatment — tinted with the locked
	// status-info palette (blue = remote) so it reads as a live status
	// badge, not a muted tag. This is the always-on cue an operator scans
	// for ("am I on my laptop or dev.box?"), analogous to VS Code's remote
	// indicator. The status palette is light/dark-only (never theme-tinted)
	// so the badge stays legible under every chrome preset.
	const sizing =
		variant === "compact"
			? "h-5 px-2 text-[11px] gap-1.5"
			: "h-5 px-1.5 text-[11px] gap-1";
	return (
		<span
			aria-label={`Workspace runtime: ${runtimeName}`}
			title={`Workspace runs on ${runtimeName}`}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full font-mono font-medium uppercase tracking-wide",
				"border border-status-info/45 bg-status-info/12 text-status-info",
				sizing,
				className,
			)}
		>
			<Server className="size-3" strokeWidth={2} />
			<span className="lowercase">{runtimeName}</span>
		</span>
	);
}
