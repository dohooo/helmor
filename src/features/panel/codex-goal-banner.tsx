/**
 * Active Codex `/goal` indicator. Renders nothing for sessions without a
 * goal (Claude sessions, fresh Codex sessions, cleared goals). Listens to
 * `CodexGoalChanged` mutations through React Query — no manual subscription.
 */
import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import type { CodexGoalState } from "@/lib/api";
import { sessionCodexGoalQueryOptions } from "@/lib/query-client";

const STATUS_LABEL: Record<CodexGoalState["status"], string> = {
	active: "active",
	paused: "paused",
	budgetLimited: "budget reached",
	complete: "complete",
};

const STATUS_TONE: Record<CodexGoalState["status"], string> = {
	active: "text-app-foreground",
	paused: "text-app-muted-foreground",
	budgetLimited: "text-amber-500",
	complete: "text-emerald-500",
};

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

export function CodexGoalBanner({ sessionId }: { sessionId: string }) {
	const { data: goal } = useQuery(sessionCodexGoalQueryOptions(sessionId));
	if (!goal) return null;

	const used = formatTokens(goal.tokensUsed);
	const budget =
		goal.tokenBudget != null ? formatTokens(goal.tokenBudget) : null;

	return (
		<div className="flex items-center gap-2 border-app-border border-b bg-app-base px-4 py-2 text-xs">
			<Target className="size-3.5 shrink-0 text-app-muted-foreground" />
			<span className="truncate font-medium text-app-foreground">
				{goal.objective}
			</span>
			<span className={`shrink-0 ${STATUS_TONE[goal.status]}`}>
				{STATUS_LABEL[goal.status]}
			</span>
			<span className="shrink-0 text-app-muted-foreground">
				{budget ? `${used} / ${budget} tokens` : `${used} tokens`}
			</span>
		</div>
	);
}
