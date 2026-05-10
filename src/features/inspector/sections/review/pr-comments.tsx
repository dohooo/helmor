import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, MessageSquare, MinusCircle, X } from "lucide-react";
import { CachedAvatar } from "@/components/cached-avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PrCommentInfo } from "@/lib/api";
import { workspaceChangeRequestCommentsQueryOptions } from "@/lib/query-client";
import { cn } from "@/lib/utils";

interface PrCommentsSectionProps {
	workspaceId: string | null;
	hasChangeRequest: boolean;
}

/**
 * Read-only timeline of issue comments + review summaries on the
 * workspace's PR. Lazy: the query stays disabled until a change request
 * is known to exist, so workspaces that haven't pushed yet don't fan
 * out a wasted GraphQL round-trip. Newest-first ordering is enforced
 * server-side; we just render in the order received.
 */
export function PrCommentsSection({
	workspaceId,
	hasChangeRequest,
}: PrCommentsSectionProps) {
	const query = useQuery({
		...workspaceChangeRequestCommentsQueryOptions(workspaceId ?? ""),
		enabled: !!workspaceId && hasChangeRequest,
	});

	if (!hasChangeRequest) {
		return null;
	}

	const comments = query.data ?? [];

	return (
		<section
			className="flex min-h-0 shrink-0 flex-col border-t border-border/50"
			aria-label="Pull request comments"
		>
			<header className="flex h-7 shrink-0 items-center justify-between px-2.5">
				<div className="flex items-center gap-1.5">
					<span className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
						Comments
					</span>
					{comments.length > 0 ? (
						<span className="rounded-sm bg-foreground/10 px-1 text-[10px] font-medium tabular-nums text-foreground/80">
							{comments.length}
						</span>
					) : null}
				</div>
			</header>
			{query.isLoading ? (
				<div className="px-2.5 py-2 text-[11px] text-muted-foreground/70">
					Loading comments…
				</div>
			) : comments.length === 0 ? (
				<div className="px-2.5 py-2 text-[11px] text-muted-foreground/70">
					No comments yet.
				</div>
			) : (
				<ScrollArea className="flex-1">
					<ul className="flex flex-col">
						{comments.map((comment) => (
							<CommentRow key={comment.id} comment={comment} />
						))}
					</ul>
				</ScrollArea>
			)}
		</section>
	);
}

function CommentRow({ comment }: { comment: PrCommentInfo }) {
	const date = new Date(comment.createdAt);
	const dateLabel = Number.isNaN(date.getTime())
		? comment.createdAt
		: relativeShort(date);
	return (
		<li
			className="cursor-pointer border-b border-border/30 px-2.5 py-2 last:border-b-0 hover:bg-foreground/[0.025]"
			onClick={() => void openUrl(comment.url)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					void openUrl(comment.url);
				}
			}}
		>
			<div className="flex items-start gap-2">
				<CachedAvatar
					size="sm"
					className="size-5 shrink-0"
					src={comment.authorAvatarUrl}
					alt={comment.authorLogin}
					fallback={comment.authorLogin.charAt(0).toUpperCase()}
					fallbackClassName="bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5 text-[11px]">
						<span className="truncate font-medium text-foreground/90">
							{comment.authorLogin}
						</span>
						{comment.kind === "review" && comment.reviewState ? (
							<ReviewBadge state={comment.reviewState} />
						) : null}
						<span className="ml-auto shrink-0 text-muted-foreground/70">
							{dateLabel}
						</span>
					</div>
					{comment.body.trim() ? (
						<p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/80">
							{comment.body}
						</p>
					) : null}
				</div>
			</div>
		</li>
	);
}

function ReviewBadge({ state }: { state: string }) {
	const normalized = state.toUpperCase();
	if (normalized === "APPROVED") {
		return (
			<span className="inline-flex items-center gap-0.5 rounded-sm bg-emerald-500/15 px-1 text-[10px] font-medium text-emerald-500">
				<Check className="size-2.5" strokeWidth={3} />
				approved
			</span>
		);
	}
	if (normalized === "CHANGES_REQUESTED") {
		return (
			<span className="inline-flex items-center gap-0.5 rounded-sm bg-destructive/15 px-1 text-[10px] font-medium text-destructive">
				<X className="size-2.5" strokeWidth={3} />
				changes requested
			</span>
		);
	}
	if (normalized === "DISMISSED") {
		return (
			<span className="inline-flex items-center gap-0.5 rounded-sm bg-muted px-1 text-[10px] font-medium text-muted-foreground">
				<MinusCircle className="size-2.5" strokeWidth={2} />
				dismissed
			</span>
		);
	}
	return (
		<span
			className={cn(
				"inline-flex items-center gap-0.5 rounded-sm bg-foreground/10 px-1 text-[10px] font-medium text-muted-foreground",
			)}
		>
			<MessageSquare className="size-2.5" strokeWidth={2} />
			commented
		</span>
	);
}

/** Compact relative time — `5m`, `3h`, `2d`, then absolute date. */
function relativeShort(date: Date): string {
	const now = Date.now();
	const diff = Math.max(0, now - date.getTime());
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return date.toLocaleDateString();
}
