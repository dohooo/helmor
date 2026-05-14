import type { ContextCardStateTone } from "@/lib/sources/types";

export const STATE_TONE_CLASS: Record<ContextCardStateTone, string> = {
	open: "text-[var(--workspace-pr-open-accent)]",
	closed: "text-[var(--workspace-pr-merged-accent)]",
	merged: "text-[var(--workspace-pr-merged-accent)]",
	draft: "text-muted-foreground",
	answered: "text-[var(--workspace-pr-open-accent)]",
	unanswered: "text-[var(--workspace-pr-conflicts-accent)]",
	urgent: "text-[var(--workspace-pr-closed-accent)]",
	neutral: "text-muted-foreground",
};
