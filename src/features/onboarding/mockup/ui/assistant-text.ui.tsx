import type { ReactNode } from "react";

/**
 * Pure-UI wrapper for assistant prose text. Mirrors the styling of
 * `AssistantText` (in `assistant-message.tsx`) without the streamdown +
 * settings-driven font size machinery, so the onboarding mockup can drop in
 * a static paragraph that visually matches a real reply.
 */
export function AssistantTextUI({
	children,
	fontSize = 13,
}: {
	children: ReactNode;
	fontSize?: number;
}) {
	return (
		<div
			className="conversation-markdown assistant-markdown-scale max-w-none break-words text-foreground"
			style={{ fontSize: `${fontSize}px` }}
		>
			{children}
		</div>
	);
}
