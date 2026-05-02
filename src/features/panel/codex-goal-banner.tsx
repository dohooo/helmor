/**
 * Active Codex `/goal` indicator. Renders nothing for sessions without a
 * goal (Claude sessions, fresh Codex sessions, cleared goals). Listens to
 * `CodexGoalChanged` mutations through React Query — no manual subscription.
 *
 * Pause / Resume / Clear buttons call `mutateCodexGoal` directly so the
 * lifecycle operations don't show up in the chat as user messages.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Target, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type CodexGoalState, mutateCodexGoal } from "@/lib/api";
import {
	helmorQueryKeys,
	sessionCodexGoalQueryOptions,
} from "@/lib/query-client";

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
	const queryClient = useQueryClient();
	const { data: goal } = useQuery(sessionCodexGoalQueryOptions(sessionId));

	const mutation = useMutation({
		mutationFn: (action: "pause" | "resume" | "clear") =>
			mutateCodexGoal(sessionId, action),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionCodexGoal(sessionId),
			});
		},
		onError: (err: unknown) => {
			toast.error(err instanceof Error ? err.message : "Failed to update goal");
		},
	});

	if (!goal) return null;

	const used = formatTokens(goal.tokensUsed);
	const budget =
		goal.tokenBudget != null ? formatTokens(goal.tokenBudget) : null;
	const isPending = mutation.isPending;

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
			<div className="ml-auto flex shrink-0 items-center gap-1">
				{goal.status === "active" && (
					<Button
						variant="ghost"
						size="sm"
						className="h-6 gap-1 px-2 text-xs"
						disabled={isPending}
						onClick={() => mutation.mutate("pause")}
					>
						<Pause className="size-3" />
						Pause
					</Button>
				)}
				{goal.status === "paused" && (
					<Button
						variant="ghost"
						size="sm"
						className="h-6 gap-1 px-2 text-xs"
						disabled={isPending}
						onClick={() => mutation.mutate("resume")}
					>
						<Play className="size-3" />
						Resume
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					className="h-6 gap-1 px-2 text-xs"
					disabled={isPending}
					onClick={() => mutation.mutate("clear")}
				>
					<X className="size-3" />
					Clear
				</Button>
			</div>
		</div>
	);
}
