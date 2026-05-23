import { Suspense } from "react";
import { LazyStreamdown } from "@/components/streamdown-loader";
import type { SlackMessage } from "@/lib/api";
import { formatRelativeTime } from "../common";

/** Single Slack message bubble. Avatar + author + relative ts +
 *  mrkdwn-as-markdown body + flat reaction summary. Slack's mrkdwn is
 *  close enough to GFM that Streamdown renders most things correctly
 *  out of the box; the few syntactic gaps (e.g. `<@U123>` user pings)
 *  fall through as literal text in v1 — good enough for v1, formalising
 *  a full mrkdwn→md transformer is a v2 task. */
export function SlackMessageBubble({ message }: { message: SlackMessage }) {
	const body = message.text.trim() || "_(empty message)_";
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
				<div className="conversation-markdown mt-0.5 break-words text-ui leading-6 text-foreground">
					<Suspense
						fallback={<div className="whitespace-pre-wrap">{body}</div>}
					>
						<LazyStreamdown className="conversation-streamdown" mode="static">
							{body}
						</LazyStreamdown>
					</Suspense>
				</div>
				{message.reactions.length > 0 ? (
					<div className="mt-1 flex flex-wrap gap-1">
						{message.reactions.map((r) => (
							<span
								key={r.name}
								className="inline-flex items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5 text-mini text-muted-foreground"
								title={`:${r.name}:`}
							>
								<span>:{r.name}:</span>
								<span className="font-medium text-foreground">{r.count}</span>
							</span>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

function initialsFor(name: string): string {
	const parts = name.trim().split(/\s+/).slice(0, 2);
	return parts.map((p) => p[0]).join("") || "?";
}
