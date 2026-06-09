import { memo, useEffect } from "react";
import { recordMessageRender } from "@/lib/dev-render-debug";
import { ChatAssistantMessage } from "./assistant-message";
import type { RenderedMessage } from "./shared";
import { ChatSystemMessage } from "./system-message";
import { ChatUserMessage } from "./user-message";

/**
 * Dev-only per-row render counter. Rendered (returns null) only under
 * `import.meta.env.DEV`, so prod never mounts it and never schedules the
 * no-dep-array effect for every message row (the recorder itself already
 * no-ops outside the ?debugRenderCounts=1 dev flag). Kept as its own
 * component — rather than a `if (DEV) useEffect()` inside ConversationMessage
 * — so the row's hook order stays unconditional and the React Compiler keeps
 * memoizing it.
 */
function MessageRenderProbe({
	sessionId,
	messageKey,
}: {
	sessionId: string;
	messageKey: string;
}) {
	useEffect(() => {
		recordMessageRender(sessionId, messageKey);
	});
	return null;
}

function ConversationMessage({
	message,
	previousAssistantMessage,
	sessionId,
	itemIndex,
}: {
	message: RenderedMessage;
	previousAssistantMessage?: RenderedMessage | null;
	sessionId: string;
	itemIndex: number;
}) {
	const messageKey = message.id ?? `${message.role}:${itemIndex}`;
	const streaming = message.role === "assistant" && message.streaming === true;

	// Dev-only render counter; renders null (no DOM) and is dropped from prod
	// builds since `import.meta.env.DEV` is statically false there.
	const renderProbe = import.meta.env.DEV ? (
		<MessageRenderProbe sessionId={sessionId} messageKey={messageKey} />
	) : null;

	if (message.role === "user") {
		return (
			<>
				{renderProbe}
				<ChatUserMessage message={message} />
			</>
		);
	}

	if (message.role === "assistant") {
		return (
			<>
				{renderProbe}
				<ChatAssistantMessage message={message} streaming={streaming} />
			</>
		);
	}

	return (
		<>
			{renderProbe}
			<ChatSystemMessage
				message={message}
				previousAssistantMessage={previousAssistantMessage}
			/>
		</>
	);
}

export const MemoConversationMessage = memo(
	ConversationMessage,
	(prev, next) => {
		return (
			prev.message === next.message &&
			prev.previousAssistantMessage === next.previousAssistantMessage &&
			prev.sessionId === next.sessionId &&
			prev.itemIndex === next.itemIndex
		);
	},
);
