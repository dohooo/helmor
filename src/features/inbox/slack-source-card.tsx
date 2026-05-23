import { AtSign, MessageCircle, MessagesSquare } from "lucide-react";
import { memo } from "react";
import { toast } from "sonner";
import {
	AppendContextButton,
	type AppendContextPayload,
} from "@/components/append-context-button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { type SlackInboxItem, slackPrepareThreadContext } from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import {
	formatSlackTextPlain,
	renderSlackText,
	type SlackEmoji,
} from "@/lib/slack-text";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { buildCardContextPayload } from "./source-card";

/** Slack-specific list card. Diverges from `SourceCard` because the
 *  visual contract is fundamentally different: Slack notifications are
 *  conversational (avatar + author + body) rather than artifact-like
 *  (title + id + state) the way GitHub/GitLab issues are. We still
 *  hand back into the same `ContextCard` for `onOpen` /
 *  `appendContextTarget` so the detail panel and composer integration
 *  stay unchanged. */
export const SlackSourceCard = memo(function SlackSourceCard({
	item,
	card,
	myUserId,
	emoji,
	selected = false,
	onOpen,
	appendContextTarget,
}: {
	item: SlackInboxItem;
	/** `ContextCard` form of `item` — used by `onOpen` + the
	 *  append-context payload builder. Kept separate so the consumer
	 *  doesn't have to re-derive it inside this component. */
	card: ContextCard;
	myUserId: string | null;
	emoji: Record<string, SlackEmoji>;
	onOpen?: (card: ContextCard) => void;
	selected?: boolean;
	appendContextTarget?: ComposerInsertTarget;
}) {
	const meta = describeKind(item);
	return (
		<article
			aria-label={`${item.authorName}: ${formatSlackTextPlain(item.textSnippet)}`}
			role={onOpen ? "button" : undefined}
			tabIndex={onOpen ? 0 : undefined}
			onClick={() => onOpen?.(card)}
			onKeyDown={(event) => {
				if (!onOpen || (event.key !== "Enter" && event.key !== " ")) return;
				event.preventDefault();
				onOpen(card);
			}}
			className={cn(
				"group relative flex gap-2.5 overflow-hidden rounded-lg border border-border/70 bg-[var(--sidebar)] px-3 py-2.5 text-left shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
				onOpen && "cursor-interactive",
				"hover:border-border hover:bg-[var(--accent)]",
				selected && "border-border bg-[var(--accent)]",
			)}
		>
			<SlackAvatar
				name={item.authorName}
				avatarUrl={item.authorAvatarUrl}
				className="shrink-0"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-baseline justify-between gap-2">
					<span className="truncate text-ui font-semibold text-foreground">
						{item.authorName}
					</span>
					<span className="shrink-0 text-mini text-muted-foreground">
						{formatRelativeTime(item.tsMillis)}
					</span>
				</div>
				<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-mini text-muted-foreground">
					<meta.Icon className="size-3 shrink-0" strokeWidth={2} />
					<span className="shrink-0">{meta.label}</span>
					{meta.chip ? <ChannelChip label={meta.chip} /> : null}
				</div>
				<p className="mt-1 line-clamp-2 break-words text-mini leading-[18px] text-foreground">
					{renderSlackText(item.textSnippet, { myUserId, emoji })}
				</p>
			</div>
			<div
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-y-0 right-0 w-20 bg-[linear-gradient(to_top_left,var(--accent)_0%,var(--accent)_34%,color-mix(in_oklch,var(--accent)_70%,transparent)_58%,transparent_100%)] opacity-0 transition-opacity duration-150",
					"group-hover:opacity-100",
				)}
			/>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="absolute right-1 bottom-0.5 z-10 inline-flex">
						<AppendContextButton
							subjectLabel={card.title}
							ariaLabel="Add to context"
							getPayload={() =>
								prepareSlackContextPayload(item, card, appendContextTarget)
							}
							errorTitle="Couldn't insert context card"
							className={cn(
								"flex size-7.5 cursor-interactive items-center justify-center rounded-md",
								"border-0 bg-transparent text-muted-foreground opacity-0 shadow-none",
								"transition-[background-color,color,opacity,transform] duration-150",
								"group-hover:opacity-100",
								"hover:bg-foreground/10 hover:text-foreground",
								"focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
								"active:scale-95 [&_svg]:size-3.5",
							)}
						/>
					</span>
				</TooltipTrigger>
				<TooltipContent side="top">Add to context</TooltipContent>
			</Tooltip>
		</article>
	);
});

/** Build the rich "add to context" payload for a Slack inbox card.
 *
 *  Unlike the generic `buildCardContextPayload` (which just stitches
 *  `card.title` + `externalId` + `URL` into four lines), this fetches
 *  the whole thread on demand, pre-warms every inline image/gif/video
 *  poster into the local Slack file cache, and stitches a structured
 *  prompt that includes absolute local paths next to each file. The
 *  agent can `Read` those paths to see what the user is referencing.
 *
 *  A single sonner toast tracks progress: it switches from
 *  "Preparing Slack context…" to "Caching images N/M" to a brief
 *  success state, all under one stable toast id so it updates in
 *  place instead of stacking. On failure we fall back to the basic
 *  payload — better a degraded card than no card. */
async function prepareSlackContextPayload(
	item: SlackInboxItem,
	card: ContextCard,
	appendContextTarget: ComposerInsertTarget | undefined,
): Promise<AppendContextPayload> {
	const toastId = `slack-prepare:${item.id}`;
	toast.loading("Preparing Slack context…", {
		id: toastId,
		description: "Fetching thread",
	});
	try {
		const prepared = await slackPrepareThreadContext({
			teamId: item.teamId,
			channelId: item.channelId,
			// Backend prefers replies when the anchor is itself a thread
			// root; otherwise it falls back to channel history. We don't
			// know thread_ts client-side, so let the backend decide.
			threadTs: null,
			anchorTs: item.ts,
			onProgress: (event) => {
				if (event.stage === "fetchingThread") {
					toast.loading("Preparing Slack context…", {
						id: toastId,
						description: "Fetching thread",
					});
				} else if (event.stage === "cachingFiles") {
					toast.loading("Preparing Slack context…", {
						id: toastId,
						description:
							event.total === 0
								? "No attachments to cache"
								: `Caching attachments ${event.current + 1}/${event.total}`,
					});
				}
			},
		});

		// Summarise what the agent will actually see: the thread chip
		// plus N image attachments (vision input). A partial-failure
		// count (some files failed to cache) surfaces in the
		// description so the user understands when a few images
		// silently fell off the wire.
		const attachedCount = prepared.imagePaths.length;
		const totalImageCandidates = prepared.filesTotal;
		const summary = (() => {
			if (totalImageCandidates === 0) return "Thread inlined";
			if (attachedCount === totalImageCandidates) {
				return attachedCount === 1
					? "Thread inlined · 1 image attached"
					: `Thread inlined · ${attachedCount} images attached`;
			}
			return `Thread inlined · ${attachedCount}/${totalImageCandidates} images attached (rest unavailable)`;
		})();
		toast.success("Slack context ready", {
			id: toastId,
			description: summary,
		});

		// Build the same `custom-tag` insert shape as the generic path,
		// but swap `submitText` for the enriched prompt so the agent
		// sees the full thread instead of the 4-line summary. We then
		// APPEND one `kind: "image"` insert item per cached attachment
		// — the composer renders each as an ImageBadgeNode (hover-able
		// preview chip), and the existing submit pipeline lifts every
		// imagePath into the message's vision input array.
		const fallbackPayload = buildCardContextPayload(card, appendContextTarget);
		const imageItems = prepared.imagePaths.map((path) => ({
			kind: "image" as const,
			path,
		}));
		if ("items" in fallbackPayload && fallbackPayload.items[0]) {
			const first = fallbackPayload.items[0];
			if (first.kind === "custom-tag") {
				const updatedPreview =
					first.preview && first.preview.kind === "text"
						? { ...first.preview, text: prepared.submitText }
						: first.preview;
				return {
					...fallbackPayload,
					items: [
						{
							...first,
							submitText: prepared.submitText,
							preview: updatedPreview,
						},
						...fallbackPayload.items.slice(1),
						...imageItems,
					],
				};
			}
		}
		return fallbackPayload;
	} catch (error) {
		toast.error("Couldn't prepare Slack context", {
			id: toastId,
			description:
				error instanceof Error
					? error.message
					: "Falling back to summary-only context.",
		});
		// Degraded fallback so the user still gets something inserted.
		return buildCardContextPayload(card, appendContextTarget);
	}
}

function SlackAvatar({
	name,
	avatarUrl,
	className,
}: {
	name: string;
	avatarUrl: string | null;
	className?: string;
}) {
	if (avatarUrl) {
		return (
			<img
				src={avatarUrl}
				alt={name}
				width={32}
				height={32}
				loading="lazy"
				className={cn("size-8 rounded-md object-cover", className)}
			/>
		);
	}
	return (
		<div
			className={cn(
				"flex size-8 items-center justify-center rounded-md bg-muted text-mini font-medium uppercase text-muted-foreground",
				className,
			)}
		>
			{initialsFor(name)}
		</div>
	);
}

function ChannelChip({ label }: { label: string }) {
	return (
		<span className="inline-flex max-w-[180px] items-center truncate rounded bg-muted px-1 text-mini text-foreground">
			{label}
		</span>
	);
}

/** Compute the type-label + icon + channel-chip text for a Slack inbox
 *  item. Three flavours, mirroring Slack desktop's Activity row:
 *   - Direct message      → "DM" with partner-name chip.
 *   - Threaded mention    → "Thread in" + channel chip.
 *   - Top-level mention   → "Mention in" + channel chip.
 *  Returned as a triple the card renders unconditionally. */
function describeKind(item: SlackInboxItem): {
	Icon: typeof AtSign;
	label: string;
	chip: string | null;
} {
	if (item.kind === "direct_message") {
		return {
			Icon: MessageCircle,
			label: "DM",
			chip: dmPartnerLabel(item.channelLabel),
		};
	}
	if (item.threadTs) {
		return {
			Icon: MessagesSquare,
			label: "Thread in",
			chip: item.channelLabel,
		};
	}
	return { Icon: AtSign, label: "Mention in", chip: item.channelLabel };
}

/** `channelLabel` for DMs comes back as `"DM · Partner"` (or
 *  `"Group · …"` for MPIMs). The "DM"/"Group" tag is already carried by
 *  the kind label, so we strip the prefix so the chip reads as just the
 *  partner/group name. Falls back to the raw label when the prefix is
 *  absent (e.g. legacy data). */
function dmPartnerLabel(channelLabel: string): string | null {
	if (channelLabel.startsWith("DM · ")) return channelLabel.slice(5) || null;
	if (channelLabel.startsWith("Group · ")) return channelLabel.slice(8) || null;
	return channelLabel || null;
}

function initialsFor(name: string): string {
	const parts = name.trim().split(/\s+/).slice(0, 2);
	return parts.map((p) => p[0]).join("") || "?";
}

function formatRelativeTime(timestamp: number) {
	const deltaMs = Date.now() - timestamp;
	const minutes = Math.max(1, Math.round(deltaMs / 60_000));
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.round(hours / 24);
	return `${days}d ago`;
}
