import { Tag } from "lucide-react";
import { FileMentionBadge } from "@/components/file-mention-badge";
import { InlineBadge } from "@/components/inline-badge";
import type { MessagePart } from "@/lib/api";
import {
	buildComposerPreviewLabel,
	type ComposerPreviewPayload,
	inferComposerPreviewLanguage,
} from "@/lib/composer-insert";
import { useSettings } from "@/lib/settings";
import { CopyMessageButton } from "./copy-message";
import type { RenderedMessage } from "./shared";
import { isFileMentionPart, isPastedTextPart, isTextPart } from "./shared";

// Attachments arrive as structured `file-mention` parts and pasted tags as
// `pasted-text` parts (see `splitTextWithFiles`); the file badge picks file
// vs image by extension. Do not regex-scan text parts for `@<path>` — it
// would truncate paths containing whitespace.

/**
 * A pasted-text tag span, rendered with the SAME chip the composer shows
 * before sending: label from the first content line, hover opens the
 * preview popover with the full (highlighted) content.
 */
function PastedTextBadge({ text }: { text: string }) {
	const language = inferComposerPreviewLanguage(text);
	const label = buildComposerPreviewLabel(text, language ? "code" : "text");
	const preview: ComposerPreviewPayload = language
		? { kind: "code", title: label, code: text, language }
		: { kind: "text", title: label, text };
	return (
		<InlineBadge
			icon={
				<Tag
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
			}
			label={label}
			preview={preview}
			nonSelectable={false}
		/>
	);
}

export function ChatUserMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];
	const { settings } = useSettings();

	return (
		<div
			data-message-id={message.id}
			data-message-role="user"
			className="group/user flex min-w-0 justify-end"
		>
			<div className="relative flex max-w-[75%] min-w-0 flex-col items-end pb-5">
				<div
					className="conversation-body-text w-full overflow-hidden rounded-md bg-accent/55 px-3 py-2 leading-7"
					style={{ fontSize: `${settings.chatFontSize}px` }}
				>
					<p className="whitespace-pre-wrap break-words">
						{parts.map((part, index) => {
							if (isTextPart(part)) {
								return <span key={index}>{part.text}</span>;
							}
							if (isFileMentionPart(part)) {
								return <FileMentionBadge key={index} path={part.path} />;
							}
							if (isPastedTextPart(part)) {
								return <PastedTextBadge key={index} text={part.text} />;
							}
							return null;
						})}
					</p>
				</div>
				<div className="pointer-events-none absolute right-1 bottom-0 flex items-center justify-end opacity-0 group-hover/user:pointer-events-auto group-hover/user:opacity-100 group-focus-within/user:pointer-events-auto group-focus-within/user:opacity-100">
					<CopyMessageButton
						message={message}
						className="size-5 shrink-0 text-muted-foreground/28 hover:text-muted-foreground"
					/>
				</div>
			</div>
		</div>
	);
}
