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
import {
	goalElapsedText,
	goalStatusIndicatorText,
	goalTokensText,
} from "./codex-goal-display";

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

	const indicator = goalStatusIndicatorText(goal);
	const elapsed = goalElapsedText(goal);
	const tokens = goalTokensText(goal);
	const canResume =
		goal.status === "paused" ||
		goal.status === "blocked" ||
		goal.status === "usageLimited";
	const isPending = clearMutation.isPending || disabled;

	return (
		<div
			data-testid="codex-goal-banner"
			className={cn(
				"pointer-events-auto flex items-center gap-2 border border-secondary/80 bg-background px-3 py-1.5 text-small",
				hasQueueBelow
					? "mx-auto w-fit max-w-[90%] rounded-md shadow-sm"
					: "mx-auto w-[90%] rounded-t-2xl border-b-0",
			)}
		>
			<Goal
				className="size-3.5 shrink-0 self-start text-muted-foreground/70"
				strokeWidth={1.8}
				aria-hidden
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center justify-between gap-3">
					<span className="min-w-0 truncate text-small font-medium tracking-[0.01em] text-foreground">
						{indicator} ({elapsed})
					</span>
					<span className="shrink-0 text-mini text-muted-foreground/70">
						{tokens}
					</span>
				</div>
				<div className="min-w-0 truncate text-small text-muted-foreground/80">
					Objective: {goal.objective}
				</div>
			</div>
			<div className="ml-auto flex shrink-0 items-center gap-1 self-start">
				{canResume && onResume ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label="Resume goal"
						disabled={isPending}
						onClick={onResume}
						className="h-7 gap-1 rounded-md px-2 text-small font-medium text-muted-foreground hover:text-foreground"
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
					className="h-7 gap-1 rounded-md px-2 text-small font-medium text-muted-foreground hover:text-foreground"
				>
					<X className="size-[13px] shrink-0" strokeWidth={1.8} />
					<span>Clear</span>
				</Button>
			</div>
		</div>
	);
}
