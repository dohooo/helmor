import { openUrl } from "@tauri-apps/plugin-opener";
import { FileAudio, FileText, Paperclip } from "lucide-react";
import type { SlackFileRef } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A grid of file thumbnails / chips rendered below the message body.
 *  Inline preview for images / gifs / videos via the `slack-file://`
 *  custom protocol; PDFs / audio / unknown types render as a tappable
 *  chip that opens the original file in the user's browser.
 *
 *  Layout: 2-up grid on wide messages, single column when narrow.
 *  `justify-items-start` keeps each tile from being stretched by the
 *  grid so the inner `<button>` (inline-block) can hug the image
 *  exactly — no letterbox / empty padding inside the rounded frame.
 *  `max-w-[50%]` on the single-file grid acts as an upper bound only,
 *  not a forced width: a narrow landscape stays at its natural size,
 *  a wide or tall image scales down to fit the cap. */
export function SlackFilePreviewGrid({ files }: { files: SlackFileRef[] }) {
	if (files.length === 0) return null;
	return (
		<div
			className={cn(
				"mt-1 grid gap-1.5 justify-items-start",
				// Single-file: ≤ 50% of message body width.
				// Multi-file: 2-column grid (each tile already implicitly
				// at ≤ 50% body via the column split).
				files.length === 1 ? "grid-cols-1 max-w-[50%]" : "grid-cols-2",
			)}
		>
			{files.map((file) => (
				<SlackFilePreview key={file.id} file={file} />
			))}
		</div>
	);
}

function SlackFilePreview({ file }: { file: SlackFileRef }) {
	switch (file.category) {
		case "image":
		case "gif":
			return <ImagePreview file={file} />;
		case "video":
			return <VideoPreview file={file} />;
		default:
			return <FileChip file={file} />;
	}
}

function ImagePreview({ file }: { file: SlackFileRef }) {
	if (!file.previewUrl) return <FileChip file={file} />;
	const sourceUrl = file.sourceUrl ?? file.previewUrl;
	// The `<img>` sizes itself: natural `width`/`height` attrs prevent
	// layout shift, and `max-w-full` / `max-h-[60vh]` scale it down to
	// fit the cell while preserving aspect ratio. The `<button>` is
	// `inline-block` so the rounded border hugs the image — no
	// letterbox.
	return (
		<button
			type="button"
			onClick={() => sourceUrl && void openExternal(sourceUrl)}
			className={cn(
				"inline-block max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted",
				"cursor-interactive transition-colors",
				"hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
			)}
		>
			<img
				src={file.previewUrl}
				alt={file.name}
				title={file.name}
				loading="lazy"
				width={file.width ?? undefined}
				height={file.height ?? undefined}
				className="block h-auto max-h-[60vh] w-auto max-w-full"
			/>
		</button>
	);
}

function VideoPreview({ file }: { file: SlackFileRef }) {
	// `sourceUrl` is the original `url_private` rewritten to
	// `slack-file://` — the protocol handler proxies it through the
	// workspace cookie. Fall back to a chip when Slack didn't return
	// a playable source (shouldn't happen for `video/*` mime, but defensive).
	if (!file.sourceUrl) return <FileChip file={file} />;
	return (
		// biome-ignore lint/a11y/useMediaCaption: Slack uploads don't carry caption tracks and we have no way to author them in Helmor.
		<video
			controls
			// `metadata` only fetches the MOOV atom (≤ a few hundred KB)
			// up front. Bytes for actual playback stream in on demand
			// once the user hits play. Without this, every thread mount
			// would pull the full MP4 — wasteful on bandwidth.
			preload="metadata"
			// Slack's `thumb_video` static frame doubles as the
			// `<video>` poster, so the bubble doesn't show a black box
			// while the metadata loads.
			poster={file.previewUrl ?? undefined}
			className={cn(
				"block max-h-[420px] w-full overflow-hidden rounded-lg border border-border/60 bg-black",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
			)}
		>
			<source src={file.sourceUrl} type={file.mimetype ?? "video/mp4"} />
		</video>
	);
}

function FileChip({ file }: { file: SlackFileRef }) {
	const Icon =
		file.category === "audio"
			? FileAudio
			: file.category === "pdf"
				? FileText
				: Paperclip;
	const href = file.permalink ?? file.sourceUrl;
	return (
		<button
			type="button"
			onClick={() => href && void openExternal(href)}
			className={cn(
				"flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted px-2.5 py-2 text-mini text-foreground",
				"cursor-interactive transition-colors",
				"hover:border-border hover:bg-muted/80",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
			)}
			title={file.name}
		>
			<Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
			<span className="truncate">{file.name}</span>
		</button>
	);
}

/** Open a file's source URL in the user's browser. For the
 *  `slack-file://` source URL we strip the protocol back to the
 *  original `https://files.slack.com/...` so the desktop browser
 *  (which has its own Slack session) can authenticate. The Slack
 *  `permalink` is already a public Slack web URL — pass it through
 *  unchanged. */
async function openExternal(url: string) {
	const target = url.startsWith("slack-file://")
		? `https://files.slack.com/${url.slice("slack-file://".length)}`
		: url;
	try {
		await openUrl(target);
	} catch {
		// User dismissed the system dialog or no app handles the
		// protocol — silently no-op; the visible chip stays clickable.
	}
}
