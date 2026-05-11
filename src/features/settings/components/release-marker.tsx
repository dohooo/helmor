import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Per-row "this is new" badge for settings rows. Lifecycle is fully
 * manual: add the marker prop when you want the badge to appear, remove
 * it when you no longer want it. No automatic expiry tied to the app
 * version — release cadence varies and some badges deserve to linger
 * across a few versions.
 */
export type SettingsReleaseMarker = {
	kind: "feature" | "update";
};

const RELEASE_MARKER_LABELS: Record<SettingsReleaseMarker["kind"], string> = {
	feature: "New feature",
	update: "New update",
};

const RELEASE_MARKER_CLASSES: Record<SettingsReleaseMarker["kind"], string> = {
	feature:
		"border-primary/80 bg-primary text-primary-foreground shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_22%,transparent)]",
	update: "bg-secondary text-secondary-foreground",
};

export function SettingsReleaseBadge({
	marker,
	className,
}: {
	marker?: SettingsReleaseMarker;
	className?: string;
}) {
	if (!marker) return null;

	return (
		<Badge
			variant="secondary"
			className={cn(
				"h-4 rounded-full px-1.5 py-0 text-[10px] font-medium leading-none",
				RELEASE_MARKER_CLASSES[marker.kind],
				className,
			)}
		>
			{RELEASE_MARKER_LABELS[marker.kind]}
		</Badge>
	);
}
