import type { ThreadMessageLike } from "./api";

function isRoomChatUserMessage(message: ThreadMessageLike): boolean {
	return message.role === "user" && message.isRoomChat === true;
}

function isAgentTurnStart(message: ThreadMessageLike): boolean {
	return message.role === "user" && message.isRoomChat !== true;
}

export function normalizeThreadMessagesForDisplay(
	messages: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
	const result: ThreadMessageLike[] = [];
	let changed = false;
	let index = 0;

	while (index < messages.length) {
		const message = messages[index];
		if (!message) break;
		result.push(message);
		index += 1;

		if (!isAgentTurnStart(message)) {
			continue;
		}

		const originalSegment: ThreadMessageLike[] = [];
		const agentOutput: ThreadMessageLike[] = [];
		const roomChat: ThreadMessageLike[] = [];
		while (index < messages.length) {
			const candidate = messages[index];
			if (!candidate || isAgentTurnStart(candidate)) break;
			originalSegment.push(candidate);
			if (isRoomChatUserMessage(candidate)) {
				roomChat.push(candidate);
			} else {
				agentOutput.push(candidate);
			}
			index += 1;
		}

		const normalizedSegment = [...agentOutput, ...roomChat];
		for (let offset = 0; offset < originalSegment.length; offset += 1) {
			if (originalSegment[offset] !== normalizedSegment[offset]) {
				changed = true;
				break;
			}
		}
		result.push(...normalizedSegment);
	}

	return changed ? result : (messages as ThreadMessageLike[]);
}

export function resolveStreamingFooterMessageIndex(
	data: readonly ThreadMessageLike[],
	active: boolean,
): number | null {
	if (!active) return null;
	for (let index = data.length - 1; index >= 0; index -= 1) {
		const message = data[index];
		if (message?.role === "assistant" && message.streaming === true) {
			return index;
		}
	}
	return null;
}
