/**
 * Active Codex `/goal` indicator. Sits above the composer in the same
 * floating overlay as `<SubmitQueueList />` so the two visually stack —
 * one banner + N queued submits + the composer below.
 *
 * Three button paths:
 *   - Clear: out-of-band JSON-RPC via `mutateCodexGoal` so it doesn't
 *     leave a user message in the chat.
 *   - Resume: synthesises a `/goal resume` prompt and submits it through
 *     the host-supplied callback, which routes through the sendMessage
 *     path. The resulting stream subscription is what catches the
 *     goal-continuation turn codex auto-spawns when status flips back
 *     to active. Users can also type `/goal resume` themselves —
 *     parsed identically.
 *   - Pause is NOT a banner button; it's the Composer Stop button that
 *     triggers it, so an abort during an active goal doesn't get
 *     re-spawned by codex's continuation loop.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Goal, Play, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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

export function CodexGoalBanner({
	sessionId,
	hasQueueBelow,
	disabled,
	onResume,
}: {
	sessionId: string;
	/** When the submit-queue list renders directly below us, the banner
	 *  becomes a standalone pill so the two stack as visually distinct
	 *  rows. With no queue below, the banner glues itself to the top of
	 *  the composer just like SubmitQueueList does on its own. */
	hasQueueBelow?: boolean;
	disabled?: boolean;
	/** Resume button handler. The host injects `/goal resume` through
	 *  the normal composer submit flow — see `container.tsx`. When
	 *  omitted, the Resume button hides entirely. */
	onResume?: () => void;
}) {
	const queryClient = useQueryClient();
	const queryKey = helmorQueryKeys.sessionCodexGoal(sessionId);
	const { data: goal } = useQuery(sessionCodexGoalQueryOptions(sessionId));

	const clearMutation = useMutation({
		mutationFn: () => mutateCodexGoal(sessionId, "clear"),
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<CodexGoalState | null>(
				queryKey,
			);
			queryClient.setQueryData<CodexGoalState | null>(queryKey, null);
			return { previous };
		},
		onError: (err: unknown, _vars, context) => {
			if (context?.previous !== undefined) {
				queryClient.setQueryData(queryKey, context.previous);
			}
			toast.error(err instanceof Error ? err.message : "Failed to clear goal");
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey });
		},
	});

	if (!goal) return null;

	const used = formatTokens(goal.tokensUsed);
	const budget =
		goal.tokenBudget != null ? formatTokens(goal.tokenBudget) : null;
	const isPaused = goal.status === "paused";
	const isPending = clearMutation.isPending || disabled;

	return (
		<div
			data-testid="codex-goal-banner"
			className={cn(
				"pointer-events-auto flex items-center gap-2 border border-secondary/80 bg-background px-3 py-1 text-xs",
				hasQueueBelow
					? "mx-auto w-fit max-w-[90%] rounded-md shadow-sm"
					: "mx-auto w-[90%] rounded-t-2xl border-b-0 py-1.5",
			)}
		>
			<Goal
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
				Used: {budget ? `${used} / ${budget}` : used}
			</span>
			<div className="ml-auto flex shrink-0 items-center gap-1">
				{isPaused && onResume ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label="Resume goal"
						disabled={isPending}
						onClick={onResume}
						className="h-7 gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
					>
						<Play className="size-[13px] shrink-0" strokeWidth={1.8} />
						<span>Resume</span>
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-label="Clear goal"
					disabled={isPending}
					onClick={() => clearMutation.mutate()}
					className="h-7 gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
				>
					<X className="size-[13px] shrink-0" strokeWidth={1.8} />
					<span>Clear</span>
				</Button>
			</div>
		</div>
	);
}
