/**
 * Slack mrkdwn token parser + renderer.
 *
 * Slack messages use a small set of escape sequences for entities that
 * `streamdown`/markdown don't natively understand. This module
 * tokenises them and returns ReactNode segments suitable for inline
 * rendering inside a message body or a list preview.
 *
 * Handled tokens:
 *   <@U123|name>  / <@U123>              — user mention pill
 *   <#C123|name>  / <#C123>              — channel chip
 *   <https://example.com|label>          — link with custom label
 *   <https://example.com>                — bare link
 *   <mailto:x@y.com|label>               — link with custom label
 *   :emoji_name:                         — emoji (unicode | image | fallback)
 *
 * Out of scope (rendered as raw text for now): `<!subteam^…|name>`,
 * `<!channel>`, `<!here>`, `<!date^…>`. Add a new branch in `tokenize`
 * when needed.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Resolved emoji shortcode. `unicode` = built-in unicode codepoint(s);
 *  `image` = workspace custom emoji served from the Slack CDN. */
export type SlackEmoji =
	| { kind: "unicode"; char: string }
	| { kind: "image"; url: string; name: string };

export type SlackTextOptions = {
	/** Slack user id of the currently authenticated user. Mentions
	 *  matching this id render with the accent highlight; all others
	 *  render with a muted code-block style. Pass `null` when unknown
	 *  (e.g. workspace hasn't loaded yet) — every mention will fall
	 *  back to the muted style. */
	myUserId: string | null;
	/** Merged emoji table (built-in + workspace custom). Pass an empty
	 *  object when unloaded — `:name:` will fall through to the muted
	 *  pill fallback. */
	emoji: Record<string, SlackEmoji>;
};

// ── Token regex ─────────────────────────────────────────────────────────
//
// One sweep regex with alternation, so token ordering inside the source
// is preserved naturally. Capture groups are named per-branch to keep
// the post-match dispatch readable. Worth noting: Slack doesn't escape
// `<` and `>` inside body text — if a user literally types `<@foo>` it
// IS the user-mention syntax in Slack's eyes, so we match aggressively.
const TOKEN_RE = new RegExp(
	[
		// User mention: <@U12345|display> or <@U12345>
		String.raw`<@(?<userId>[UW][A-Z0-9]+)(?:\|(?<userLabel>[^>]+))?>`,
		// Channel mention: <#C12345|name> or <#C12345>
		String.raw`<#(?<channelId>[CGD][A-Z0-9]+)(?:\|(?<channelLabel>[^>]+))?>`,
		// URL with label: <https://...|label>  or <mailto:...|label>
		String.raw`<(?<urlWithLabel>(?:https?|mailto):[^|>\s]+)\|(?<urlLabel>[^>]+)>`,
		// Bare URL: <https://...>
		String.raw`<(?<urlBare>(?:https?|mailto):[^>\s]+)>`,
		// Emoji shortcode: :name: — letters/digits/underscores/hyphens/+
		// (Slack allows hyphens for custom emoji names like
		// `:dosu-logo-party-intensifies:` and skin-tone variants like
		// `:wave-skin-tone-3:`. `+` for `:+1:` / `:-1:`.)
		String.raw`:(?<emojiName>[a-z0-9_+\-]+):`,
	].join("|"),
	"gi",
);

const SKIN_TONE_SUFFIX = /::?skin-tone-[2-6]$|-skin-tone-[2-6]$/i;

/** Slack stores skin-tone variants as separate names. We don't enumerate
 *  per-tone unicode in the built-in table (`BUILTIN_EMOJI`), so strip
 *  the suffix to fall back to the base emoji. Custom workspace emojis
 *  never use this suffix — they're whole names — so this is a no-op
 *  for them. */
export function stripSkinTone(name: string): string {
	return name.replace(SKIN_TONE_SUFFIX, "");
}

/** Look up an emoji shortcode against the merged map, with skin-tone
 *  fallback. Returns `null` when the name is unknown (caller decides
 *  the fallback rendering). */
export function resolveEmoji(
	name: string,
	emoji: Record<string, SlackEmoji>,
): SlackEmoji | null {
	const direct = emoji[name];
	if (direct) return direct;
	const stripped = stripSkinTone(name);
	if (stripped !== name && emoji[stripped]) return emoji[stripped];
	return null;
}

/** Render a Slack message text into inline ReactNodes. Plain text
 *  segments pass through; tokens become pills / images / links per the
 *  rules in this module's docstring. */
export function renderSlackText(
	text: string,
	opts: SlackTextOptions,
): ReactNode[] {
	const nodes: ReactNode[] = [];
	let cursor = 0;
	// Each match is unique; React keys derive from match index +
	// position so they remain stable inside a single render pass.
	let matchIndex = 0;
	for (const match of text.matchAll(TOKEN_RE)) {
		const start = match.index ?? 0;
		if (start > cursor) {
			nodes.push(text.slice(cursor, start));
		}
		const groups = match.groups ?? {};
		const key = `t${matchIndex++}-${start}`;
		nodes.push(renderToken(groups, key, opts));
		cursor = start + match[0].length;
	}
	if (cursor < text.length) {
		nodes.push(text.slice(cursor));
	}
	return nodes;
}

function renderToken(
	groups: Record<string, string | undefined>,
	key: string,
	opts: SlackTextOptions,
): ReactNode {
	if (groups.userId) {
		return (
			<SlackUserMention
				key={key}
				userId={groups.userId}
				label={groups.userLabel}
				myUserId={opts.myUserId}
			/>
		);
	}
	if (groups.channelId) {
		return (
			<SlackChannelChip
				key={key}
				channelId={groups.channelId}
				label={groups.channelLabel}
			/>
		);
	}
	if (groups.urlWithLabel) {
		return (
			<SlackLink key={key} href={groups.urlWithLabel}>
				{groups.urlLabel ?? groups.urlWithLabel}
			</SlackLink>
		);
	}
	if (groups.urlBare) {
		return (
			<SlackLink key={key} href={groups.urlBare}>
				{groups.urlBare}
			</SlackLink>
		);
	}
	if (groups.emojiName) {
		return (
			<SlackEmojiInline key={key} name={groups.emojiName} emoji={opts.emoji} />
		);
	}
	return null;
}

// ── Token components ────────────────────────────────────────────────────

export function SlackUserMention({
	userId,
	label,
	myUserId,
	className,
}: {
	userId: string;
	label?: string;
	myUserId: string | null;
	className?: string;
}) {
	const isSelf = myUserId !== null && userId === myUserId;
	const display = label ? `@${label}` : `@${userId}`;
	return (
		<span
			className={cn(
				"inline-block rounded px-1 align-baseline",
				// `bg-primary` resolves to `--accent-default` (the strong
				// accent), giving @me a high-contrast highlight against the
				// card chrome. Other mentions use the muted code-block style
				// so they read as references, not as call-outs.
				isSelf
					? "bg-primary font-medium text-primary-foreground"
					: "bg-muted font-mono text-mini text-foreground",
				className,
			)}
		>
			{display}
		</span>
	);
}

export function SlackChannelChip({
	channelId,
	label,
	className,
}: {
	channelId: string;
	label?: string;
	className?: string;
}) {
	const display = label ? `#${label}` : `#${channelId}`;
	return (
		<span
			className={cn(
				"inline-block rounded bg-muted px-1 align-baseline text-mini text-muted-foreground",
				className,
			)}
		>
			{display}
		</span>
	);
}

export function SlackLink({
	href,
	children,
}: {
	href: string;
	children: ReactNode;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
			onClick={(e) => e.stopPropagation()}
		>
			{children}
		</a>
	);
}

export function SlackEmojiInline({
	name,
	emoji,
}: {
	name: string;
	emoji: Record<string, SlackEmoji>;
}) {
	const resolved = resolveEmoji(name, emoji);
	if (resolved?.kind === "unicode") {
		// Inline unicode renders at the surrounding text size; no chrome
		// — that's what Slack does too.
		return <span aria-label={`:${name}:`}>{resolved.char}</span>;
	}
	if (resolved?.kind === "image") {
		// Custom workspace emoji. `1.1em` keeps the glyph visually flush
		// with text-line metrics; align-bottom prevents float drift.
		return (
			<img
				src={resolved.url}
				alt={`:${name}:`}
				title={`:${name}:`}
				className="inline-block size-[1.1em] -translate-y-[0.05em] align-middle"
				loading="lazy"
			/>
		);
	}
	// Unknown emoji — render as a muted pill (the "badge icon" style)
	// so the raw shortcode doesn't visually pollute the text body.
	return (
		<span className="inline-block rounded bg-muted px-1 text-mini text-muted-foreground">
			:{name}:
		</span>
	);
}

// ── Plain-text formatter ────────────────────────────────────────────────

/** Rewrite Slack mrkdwn-style tokens into a plain readable string —
 *  no React nodes, no markup. Use this for chip labels, tab titles,
 *  aria-labels, composer submit text, and any other context where the
 *  string is consumed as data rather than rendered through the pill
 *  components.
 *
 *  Token replacement table:
 *
 *    <@U123|name>          → @name
 *    <@U123>               → @U123
 *    <#C123|name>          → #name
 *    <#C123>               → #C123
 *    <https://…|label>     → label
 *    <https://…>           → https://…
 *    :emoji:               → unicode if resolvable via `opts.emoji`,
 *                            otherwise leave the `:name:` intact
 *
 *  Newlines are collapsed to single spaces — chip/tab consumers all
 *  want single-line text. Empty inputs round-trip as empty strings. */
export function formatSlackTextPlain(
	text: string,
	opts: { emoji?: Record<string, SlackEmoji> } = {},
): string {
	if (!text) return "";
	const replaced = text
		// User mention with label: <@U123|name> → @name
		.replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, "@$1")
		// User mention without label: <@U123> → @U123
		.replace(/<@([UW][A-Z0-9]+)>/g, "@$1")
		// Channel mention with label: <#C123|name> → #name
		.replace(/<#[CGD][A-Z0-9]+\|([^>]+)>/g, "#$1")
		// Channel mention without label: <#C123> → #C123
		.replace(/<#([CGD][A-Z0-9]+)>/g, "#$1")
		// URL with label: <https://…|label> → label
		.replace(/<(?:https?|mailto):[^|>\s]+\|([^>]+)>/g, "$1")
		// Bare URL: <https://…> → https://…
		.replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
		// :emoji: → unicode when the workspace table is available
		.replace(/:([a-z0-9_+-]+):/gi, (raw, name: string) => {
			if (!opts.emoji) return raw;
			const resolved = resolveEmoji(name, opts.emoji);
			return resolved?.kind === "unicode" ? resolved.char : raw;
		});
	// Collapse runs of whitespace (including \n inside textSnippet) to
	// single spaces so the result fits a one-line chip/tab cleanly.
	return replaced.replace(/\s+/g, " ").trim();
}

// ── Markdown preprocess ─────────────────────────────────────────────────

/** Rewrite Slack `:shortcode:` occurrences inside a markdown string so
 *  the downstream markdown renderer (Streamdown) handles them natively.
 *
 *  - Built-in unicode emoji → unicode character
 *  - Workspace custom emoji → `![:name:](url)` (markdown image syntax,
 *    which Streamdown turns into an inline `<img>`)
 *  - Unknown → leave as-is (`:name:`); markdown will print it verbatim
 *
 *  Use this before passing a Slack message body to `<Streamdown>`. For
 *  shorter previews not going through markdown, use `renderSlackText`
 *  instead — it preserves more structure (mention pills, channel chips,
 *  styled links) than a markdown pass can.
 */
export function inlineEmojiForMarkdown(
	text: string,
	emoji: Record<string, SlackEmoji>,
): string {
	return text.replace(/:([a-z0-9_+-]+):/gi, (raw, name: string) => {
		const resolved = resolveEmoji(name, emoji);
		if (resolved?.kind === "unicode") return resolved.char;
		if (resolved?.kind === "image") {
			// Escape `(` `)` so they don't terminate the markdown link
			// early. Slack emoji URLs are stable CDN paths so this is
			// rare but cheap to be safe.
			const safeUrl = resolved.url.replace(/\)/g, "%29").replace(/\(/g, "%28");
			return `![:${name}:](${safeUrl})`;
		}
		return raw;
	});
}
