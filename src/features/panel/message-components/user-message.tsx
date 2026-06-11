import { ChevronDown, ChevronUp, Tag } from "lucide-react";
import { FileMentionBadge } from "@/components/file-mention-badge";
import type { MessagePart } from "@/lib/api";
import {
	buildComposerPreviewLabel,
	exceedsComposerPreviewBadgeThreshold,
} from "@/lib/composer-insert";
import { useSettings } from "@/lib/settings";
import { CopyMessageButton } from "./copy-message";
import type { RenderedMessage } from "./shared";
import { isFileMentionPart, isTextPart } from "./shared";
import { useUserMessageExpansion } from "./user-message-expansion";

// Attachments arrive as structured `file-mention` parts (see
// `splitTextWithFiles`); the badge picks file vs image by extension.
// Do not regex-scan text parts for `@<path>` — it would truncate
// paths containing whitespace.

export function ChatUserMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];
	const { settings } = useSettings();

	// Same join as estimateUserMessageHeight: the collapse decision must match
	// the estimator's, which prices collapsed rows at a fixed height.
	const text = parts
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
	const collapsible = exceedsComposerPreviewBadgeThreshold(text);
	const { expanded, toggle } = useUserMessageExpansion(message.id);
	const showFullText = !collapsible || expanded;
	const hasFileMentions = parts.some(isFileMentionPart);

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
					{collapsible && (
						<button
							type="button"
							onClick={toggle}
							aria-expanded={expanded}
							className="flex max-w-full cursor-pointer items-center gap-1.5 text-left"
						>
							<Tag
								className="size-3.5 shrink-0 text-muted-foreground"
								strokeWidth={1.8}
							/>
							<span className="min-w-0 truncate font-medium">
								{buildComposerPreviewLabel(text, "text")}
							</span>
							<span className="shrink-0 whitespace-nowrap text-muted-foreground">
								{text.split("\n").length} lines
							</span>
							{expanded ? (
								<ChevronUp
									className="size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.8}
								/>
							) : (
								<ChevronDown
									className="size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.8}
								/>
							)}
						</button>
					)}
					{(showFullText || hasFileMentions) && (
						<p className="whitespace-pre-wrap break-words">
							{parts.map((part, index) => {
								if (isTextPart(part)) {
									return showFullText ? (
										<span key={index}>{part.text}</span>
									) : null;
								}
								if (isFileMentionPart(part)) {
									return <FileMentionBadge key={index} path={part.path} />;
								}
								return null;
							})}
						</p>
					)}
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
