import { describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "./api";
import { normalizeThreadMessagesForDisplay } from "./thread-message-order";

function user(id: string, options?: { room?: boolean }): ThreadMessageLike {
	return {
		id,
		role: "user",
		isRoomChat: options?.room,
		content: [{ type: "text", id: `${id}:text`, text: id }],
	};
}

function assistant(id: string): ThreadMessageLike {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", id: `${id}:text`, text: id }],
	};
}

function system(id: string): ThreadMessageLike {
	return {
		id,
		role: "system",
		content: [{ type: "text", id: `${id}:text`, text: id }],
	};
}

describe("normalizeThreadMessagesForDisplay", () => {
	it("keeps a turn's agent output before room chat that arrived while it ran", () => {
		const prompt = user("prompt");
		const roomOne = user("room-1", { room: true });
		const reply = assistant("assistant");
		const roomTwo = user("room-2", { room: true });
		const result = system("result");

		expect(
			normalizeThreadMessagesForDisplay([
				prompt,
				roomOne,
				reply,
				roomTwo,
				result,
			]).map((message) => message.id),
		).toEqual(["prompt", "assistant", "result", "room-1", "room-2"]);
	});

	it("leaves already-normalized threads reference-stable", () => {
		const messages = [
			user("prompt"),
			assistant("assistant"),
			system("result"),
			user("room", { room: true }),
		];

		expect(normalizeThreadMessagesForDisplay(messages)).toBe(messages);
	});

	it("leaves room chat before the first agent turn alone", () => {
		const messages = [user("room", { room: true })];

		expect(normalizeThreadMessagesForDisplay(messages)).toBe(messages);
	});
});
