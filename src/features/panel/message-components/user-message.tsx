import { FileText } from "lucide-react";
import { memo, useMemo } from "react";
import { ImagePreviewBadge } from "@/components/image-preview";
import type { MessagePart } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import type { RenderedMessage } from "./shared";
import { isFileMentionPart, isTextPart } from "./shared";

const USER_FILE_RE = /@(\/\S+)(?=\s|$)/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;

type UserContentSegment =
	| { type: "text"; value: string }
	| { type: "image"; value: string }
	| { type: "file"; value: string };

function splitUserContent(text: string): UserContentSegment[] {
	const segments: UserContentSegment[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(USER_FILE_RE)) {
		const matchIndex = match.index ?? 0;
		const before = text.slice(lastIndex, matchIndex);
		if (before) {
			segments.push({ type: "text", value: before });
		}
		const filePath = match[1];
		segments.push({
			type: IMAGE_EXT_RE.test(filePath) ? "image" : "file",
			value: filePath,
		});
		lastIndex = matchIndex + match[0].length;
	}
	const after = text.slice(lastIndex);
	if (after) {
		segments.push({ type: "text", value: after });
	}
	return segments;
}

const UserTextInline = memo(function UserTextInline({
	text,
}: {
	text: string;
}) {
	const segments = useMemo(() => splitUserContent(text), [text]);
	if (
		!segments.some(
			(segment) => segment.type === "image" || segment.type === "file",
		)
	) {
		return <>{text}</>;
	}
	return (
		<>
			{segments.map((segment, index) => {
				if (segment.type === "image") {
					return (
						<ImagePreviewBadge
							key={`${segment.value}-${index}`}
							path={segment.value}
						/>
					);
				}
				if (segment.type === "file") {
					return (
						<FileBadgeInline
							key={`${segment.value}-${index}`}
							path={segment.value}
						/>
					);
				}
				return <span key={index}>{segment.value}</span>;
			})}
		</>
	);
});

function FileBadgeInline({ path }: { path: string }) {
	const fileName = path.split("/").pop() ?? path;
	return (
		<span className="mx-0.5 inline-flex items-center gap-1 rounded border border-border/60 align-middle text-[12px]">
			<span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
				<FileText
					className="size-3 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
				<span className="max-w-[200px] truncate text-muted-foreground">
					{fileName}
				</span>
			</span>
		</span>
	);
}

export function ChatUserMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];
	const { settings } = useSettings();

	return (
		<div
			data-message-id={message.id}
			data-message-role="user"
			className="flex min-w-0 justify-end"
		>
			<div
				className="max-w-[75%] overflow-hidden rounded-md bg-accent/35 px-3 py-2 leading-7 text-foreground"
				style={{ fontSize: `${Math.max(settings.fontSize - 1, 12)}px` }}
			>
				<p className="whitespace-pre-wrap break-words">
					{parts.map((part, index) => {
						if (isTextPart(part)) {
							return <UserTextInline key={index} text={part.text} />;
						}
						if (isFileMentionPart(part)) {
							return <FileBadgeInline key={index} path={part.path} />;
						}
						return null;
					})}
				</p>
			</div>
		</div>
	);
}
