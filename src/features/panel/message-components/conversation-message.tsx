import { memo, useEffect } from "react";
import { recordMessageRender } from "@/lib/dev-render-debug";
import { ChatAssistantMessage } from "./assistant-message";
import type { RenderedMessage } from "./shared";
import { ChatSystemMessage } from "./system-message";
import { ChatUserMessage } from "./user-message";

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
	useEffect(() => {
		recordMessageRender(sessionId, messageKey);
	});

	const streaming = message.role === "assistant" && message.streaming === true;

	if (message.role === "user") {
		return <ChatUserMessage message={message} />;
	}

	if (message.role === "assistant") {
		return <ChatAssistantMessage message={message} streaming={streaming} />;
	}

	return (
		<ChatSystemMessage
			message={message}
			previousAssistantMessage={previousAssistantMessage}
		/>
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
