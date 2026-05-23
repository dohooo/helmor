import { openUrl } from "@tauri-apps/plugin-opener";
import { FileAudio, FileText, Paperclip, Play } from "lucide-react";
import type { SlackFileRef } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A grid of file thumbnails / chips rendered below the message body.
 *  Inline preview for images / gifs / videos via the `slack-file://`
 *  custom protocol; PDFs / audio / unknown types render as a tappable
 *  chip that opens the original file in the user's browser.
 *
 *  Layout: 2-up grid on wide messages, single column when narrow. We
 *  cap the rendered height per tile to keep long file lists from
 *  exploding the thread view. */
export function SlackFilePreviewGrid({ files }: { files: SlackFileRef[] }) {
	if (files.length === 0) return null;
	return (
		<div
			className={cn(
				"mt-1 grid gap-1.5",
				files.length === 1 ? "grid-cols-1" : "grid-cols-2",
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
	// Aspect ratio from the original dimensions (when Slack reported
	// them) keeps the layout from reflowing when the image loads.
	const aspect =
		file.width && file.height
			? { aspectRatio: `${file.width} / ${file.height}` }
			: undefined;
	const sourceUrl = file.sourceUrl ?? file.previewUrl;
	return (
		<button
			type="button"
			onClick={() => sourceUrl && void openExternal(sourceUrl, file)}
			className={cn(
				"group relative overflow-hidden rounded-lg border border-border/60 bg-muted",
				"cursor-interactive transition-colors",
				"hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
			)}
			style={aspect}
		>
			<img
				src={file.previewUrl}
				alt={file.name}
				title={file.name}
				loading="lazy"
				className="block max-h-[420px] w-full object-cover"
			/>
		</button>
	);
}

function VideoPreview({ file }: { file: SlackFileRef }) {
	if (!file.previewUrl) return <FileChip file={file} />;
	// We embed Slack's static `thumb_video` frame as a preview and
	// gate playback behind a click — full `<video>` streaming through
	// `slack-file://` works but downloading the bytes upfront on every
	// thread render is wasteful. Click opens the file externally.
	return (
		<button
			type="button"
			onClick={() => file.permalink && void openExternal(file.permalink, file)}
			className={cn(
				"group relative overflow-hidden rounded-lg border border-border/60 bg-muted",
				"cursor-interactive transition-colors",
				"hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
			)}
		>
			<img
				src={file.previewUrl}
				alt={file.name}
				title={file.name}
				loading="lazy"
				className="block max-h-[420px] w-full object-cover"
			/>
			<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 transition-colors group-hover:bg-black/40">
				<div className="flex size-12 items-center justify-center rounded-full bg-white/90 text-foreground shadow-md">
					<Play className="size-5 translate-x-[1px] fill-current" />
				</div>
			</div>
		</button>
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
			onClick={() => href && void openExternal(href, file)}
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
			{file.mimetype ? (
				<span className="shrink-0 text-muted-foreground/70">
					· {kindLabel(file.category)}
				</span>
			) : null}
		</button>
	);
}

function kindLabel(category: SlackFileRef["category"]): string {
	switch (category) {
		case "audio":
			return "Audio";
		case "pdf":
			return "PDF";
		default:
			return "File";
	}
}

/** Open a file's source URL in the user's browser. For the
 *  `slack-file://` source URL we strip the protocol back to the
 *  original `https://files.slack.com/...` so the desktop browser
 *  (which has its own Slack session) can authenticate. The Slack
 *  `permalink` is already a public Slack web URL — pass it through
 *  unchanged. */
async function openExternal(url: string, _file: SlackFileRef) {
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
