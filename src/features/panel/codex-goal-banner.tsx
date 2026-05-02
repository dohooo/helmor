/**
 * Active Codex `/goal` indicator. Sits above the composer in the same
 * floating overlay as `<SubmitQueueList />` so the two visually stack —
 * one banner + N queued submits + the composer below.
 *
 * Pause / Resume / Clear go straight to `mutateCodexGoal` so the
 * lifecycle ops never appear as user messages in the chat.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Target, X } from "lucide-react";
import { toast } from "sonner";
import { ActionRowButton } from "@/components/action-row";
import { type CodexGoalState, mutateCodexGoal } from "@/lib/api";
import {
	helmorQueryKeys,
	sessionCodexGoalQueryOptions,
} from "@/lib/query-client";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<CodexGoalState["status"], string> = {
	active: "active",
	paused: "paused",
	budgetLimited: "budget reached",
	complete: "complete",
};

const STATUS_TONE: Record<CodexGoalState["status"], string> = {
	active: "text-foreground",
	paused: "text-muted-foreground",
	budgetLimited: "text-amber-500",
	complete: "text-emerald-500",
};

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

type Action = "pause" | "resume" | "clear";

export function CodexGoalBanner({
	sessionId,
	disabled,
}: {
	sessionId: string;
	disabled?: boolean;
}) {
	const queryClient = useQueryClient();
	const queryKey = helmorQueryKeys.sessionCodexGoal(sessionId);
	const { data: goal } = useQuery(sessionCodexGoalQueryOptions(sessionId));

	const mutation = useMutation({
		mutationFn: (action: Action) => mutateCodexGoal(sessionId, action),
		onMutate: async (action) => {
			// Optimistic flip so the banner reacts immediately even if the
			// codex `thread/goal/updated` notification takes a moment to
			// round-trip back through the pipeline.
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<CodexGoalState | null>(
				queryKey,
			);
			if (action === "clear") {
				queryClient.setQueryData<CodexGoalState | null>(queryKey, null);
			} else if (previous) {
				queryClient.setQueryData<CodexGoalState | null>(queryKey, {
					...previous,
					status: action === "pause" ? "paused" : "active",
				});
			}
			return { previous };
		},
		onSuccess: (_, action) => {
			if (action === "pause") toast.success("Goal paused");
			else if (action === "resume") toast.success("Goal resumed");
			else if (action === "clear") toast.success("Goal cleared");
		},
		onError: (err: unknown, _action, context) => {
			// Roll back the optimistic update.
			if (context?.previous !== undefined) {
				queryClient.setQueryData(queryKey, context.previous);
			}
			toast.error(err instanceof Error ? err.message : "Failed to update goal");
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey });
		},
	});

	if (!goal) return null;

	const used = formatTokens(goal.tokensUsed);
	const budget =
		goal.tokenBudget != null ? formatTokens(goal.tokenBudget) : null;
	const isPending = mutation.isPending || disabled;

	return (
		<div
			data-testid="codex-goal-banner"
			className="pointer-events-auto mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-md border border-secondary/80 bg-background px-3 py-1 text-xs shadow-sm"
		>
			<Target
				className="size-3.5 shrink-0 text-muted-foreground/70"
				strokeWidth={1.8}
				aria-hidden
			/>
			<span className="truncate text-[12px] font-medium tracking-[0.01em] text-foreground">
				{goal.objective}
			</span>
			<span
				className={cn(
					"shrink-0 text-[11px] uppercase tracking-wider",
					STATUS_TONE[goal.status],
				)}
			>
				{STATUS_LABEL[goal.status]}
			</span>
			<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
				{budget ? `${used} / ${budget}` : used}
			</span>
			<div className="ml-1 flex shrink-0 items-center gap-1">
				{goal.status === "active" && (
					<ActionRowButton
						type="button"
						aria-label="Pause goal"
						disabled={isPending}
						onClick={() => mutation.mutate("pause")}
					>
						<Pause className="size-[13px] shrink-0" strokeWidth={1.8} />
						<span>Pause</span>
					</ActionRowButton>
				)}
				{goal.status === "paused" && (
					<ActionRowButton
						type="button"
						aria-label="Resume goal"
						disabled={isPending}
						onClick={() => mutation.mutate("resume")}
					>
						<Play className="size-[13px] shrink-0" strokeWidth={1.8} />
						<span>Resume</span>
					</ActionRowButton>
				)}
				<ActionRowButton
					type="button"
					aria-label="Clear goal"
					disabled={isPending}
					onClick={() => mutation.mutate("clear")}
				>
					<X className="size-[13px] shrink-0" strokeWidth={1.8} />
					<span>Clear</span>
				</ActionRowButton>
			</div>
		</div>
	);
}
