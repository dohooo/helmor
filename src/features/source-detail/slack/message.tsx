import { Suspense } from "react";
import { LazyStreamdown } from "@/components/streamdown-loader";
import type { SlackMessage } from "@/lib/api";
import {
	inlineEmojiForMarkdown,
	inlineMentionsForMarkdown,
	resolveEmoji,
	type SlackEmoji,
} from "@/lib/slack-text";
import { formatRelativeTime } from "../common";
import { SlackFilePreviewGrid } from "./file-preview";

/** Single Slack message bubble. Avatar + author + relative ts +
 *  mrkdwn-as-markdown body + flat reaction summary. We preprocess the
 *  body so any `:shortcode:` Slack uses inline becomes either a unicode
 *  emoji or a markdown `<img>` before reaching Streamdown — Streamdown
 *  doesn't speak Slack mrkdwn natively. Mention/channel/url tokens
 *  still flow through Streamdown unchanged (good enough for v1; a
 *  full Slack mrkdwn → md transformer is a v2 task).
 *
 *  Reactions render as small pills (Slack's own visual contract): the
 *  emoji icon followed by the count. Unknown shortcodes fall back to
 *  the raw `:name:` text inside the pill. */
export function SlackMessageBubble({
	message,
	emoji,
}: {
	message: SlackMessage;
	/** Workspace emoji table (built-in unicode + custom). Pass `{}`
	 *  while the workspace hasn't been resolved yet — emojis will then
	 *  render as raw `:name:` text inside their pill, which is the
	 *  same visual fallback Slack uses pre-load. */
	emoji: Record<string, SlackEmoji>;
}) {
	const trimmedText = message.text.trim();
	// Only fall back to the "(empty message)" placeholder when the
	// message has neither a textual body nor any file attachments.
	// File-only messages render their attachments inline instead.
	const placeholderNeeded = !trimmedText && message.files.length === 0;
	const rawBody = trimmedText || (placeholderNeeded ? "_(empty message)_" : "");
	// Run mention rewriting before emoji inlining so the markdown
	// pass sees `@name` text, not the raw `<@U…|name>` escape — both
	// are pure-string transforms and order is independent, but reading
	// the chain top-down is easier when mentions resolve first.
	const body = rawBody
		? inlineEmojiForMarkdown(inlineMentionsForMarkdown(rawBody), emoji)
		: "";
	return (
		<div className="flex gap-3 px-1 py-2">
			<div className="shrink-0">
				{message.authorAvatarUrl ? (
					// eslint-disable-next-line @next/next/no-img-element
					<img
						src={message.authorAvatarUrl}
						alt={message.authorName}
						width={32}
						height={32}
						className="size-8 rounded-md object-cover"
					/>
				) : (
					<div className="flex size-8 items-center justify-center rounded-md bg-muted text-mini font-medium uppercase text-muted-foreground">
						{initialsFor(message.authorName)}
					</div>
				)}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="text-ui font-semibold text-foreground">
						{message.authorName}
					</span>
					<span className="text-mini text-muted-foreground">
						{formatRelativeTime(message.tsMillis)}
					</span>
				</div>
				{body ? (
					<div className="conversation-markdown mt-0.5 break-words text-ui leading-6 text-foreground">
						<Suspense
							fallback={<div className="whitespace-pre-wrap">{body}</div>}
						>
							<LazyStreamdown className="conversation-streamdown" mode="static">
								{body}
							</LazyStreamdown>
						</Suspense>
					</div>
				) : null}
				<SlackFilePreviewGrid files={message.files} />
				{message.reactions.length > 0 ? (
					<div className="mt-1 flex flex-wrap gap-1">
						{message.reactions.map((r) => (
							<SlackReactionPill
								key={r.name}
								name={r.name}
								count={r.count}
								emoji={emoji}
							/>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** A single reaction summary in the Slack badge-icon style: a small
 *  rounded pill containing the resolved emoji + count. Three rendering
 *  branches mirror `SlackEmojiInline`: unicode glyph, custom-image, and
 *  unknown-shortcode fallback. Hover/title shows the raw `:name:` so
 *  power users can still identify the underlying emoji. */
function SlackReactionPill({
	name,
	count,
	emoji,
}: {
	name: string;
	count: number;
	emoji: Record<string, SlackEmoji>;
}) {
	const resolved = resolveEmoji(name, emoji);
	return (
		<span
			className="inline-flex items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5 text-mini text-muted-foreground"
			title={`:${name}:`}
		>
			{resolved?.kind === "image" ? (
				<img
					src={resolved.url}
					alt={`:${name}:`}
					className="size-3.5 shrink-0"
					loading="lazy"
				/>
			) : resolved?.kind === "unicode" ? (
				<span className="text-ui leading-none" aria-label={`:${name}:`}>
					{resolved.char}
				</span>
			) : (
				<span>:{name}:</span>
			)}
			<span className="font-medium text-foreground">{count}</span>
		</span>
	);
}

function initialsFor(name: string): string {
	const parts = name.trim().split(/\s+/).slice(0, 2);
	return parts.map((p) => p[0]).join("") || "?";
}
