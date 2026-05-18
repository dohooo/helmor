import type { ReactNode } from "react";

/**
 * Pure-UI body of a user message — the right-aligned chat bubble with
 * the muted-accent background. Mirrors `ChatUserMessage`'s outer shell so the
 * onboarding mockup renders the exact same visual.
 *
 * The real `ChatUserMessage` adds settings-driven font sizing, file/image
 * inline badges, and a copy button on hover; the onboarding mockup feeds plain
 * text (or arbitrary children) directly into the bubble.
 */
export function UserMessageBubbleUI({
	children,
	fontSize = 13,
}: {
	children: ReactNode;
	fontSize?: number;
}) {
	return (
		<div
			data-message-role="user"
			className="group/user flex min-w-0 justify-end"
		>
			<div className="relative flex max-w-[75%] min-w-0 flex-col items-end pb-5">
				<div
					className="conversation-body-text w-full overflow-hidden rounded-md bg-accent/55 px-3 py-2 leading-7"
					style={{ fontSize: `${fontSize}px` }}
				>
					<p className="whitespace-pre-wrap break-words">{children}</p>
				</div>
			</div>
		</div>
	);
}
