/**
 * Context-carry assembler for the @agent collaboration room (B-experience).
 *
 * Scans the rendered thread from the tail backward, stops at the first
 * `assistant` row (turn boundary), collects `room_chat` user rows (identified
 * by the `isRoomChat` marker), and builds an author-tagged
 * `<helmor-room-context>` block that the caller folds into `promptPrefix`.
 *
 * Pure function — no side effects, no React, no API calls.
 */

import type { ThreadMessageLike } from "@/lib/api";
import type { TeamMember } from "@/lib/team-api";

export type RoomCarryResult = {
	/** The assembled XML block, or null when there are no messages to carry. */
	block: string | null;
	/** Number of room-chat messages included (≥0). */
	count: number;
};

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function resolveDisplayName(
	authorId: string | undefined,
	members: readonly TeamMember[],
): string {
	if (!authorId) return "Teammate";
	const member = members.find((m) => m.id === authorId);
	if (!member) return "Teammate";
	return member.display_name ?? member.github_login ?? "Teammate";
}

function extractTextFromMessage(msg: ThreadMessageLike): string {
	const parts: string[] = [];
	for (const part of msg.content) {
		if (typeof part === "string") {
			parts.push(part);
		} else if (
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
		) {
			parts.push(part.text);
		}
	}
	return parts.join("").trim();
}

/**
 * Build the author-tagged transcript block from the current thread.
 *
 * Scans `messages` tail-backward, stops at the first `role === "assistant"`
 * message (the most recent agent turn boundary), collects all `isRoomChat`
 * user rows between now and that boundary, and returns the assembled block.
 *
 * The order in the block is chronological (oldest first) — messages are
 * collected in reverse-scan order then reversed before rendering.
 */
export function buildRoomCarryTranscript(
	messages: readonly ThreadMessageLike[],
	members: readonly TeamMember[],
): RoomCarryResult {
	const collected: ThreadMessageLike[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			// First assistant row from the tail = turn boundary; stop here.
			break;
		}
		if (msg.role === "user" && msg.isRoomChat === true) {
			collected.push(msg);
		}
	}

	if (collected.length === 0) {
		return { block: null, count: 0 };
	}

	// Reverse so the block is chronological (oldest at the top).
	collected.reverse();

	const lines = collected.map((msg) => {
		const authorId = msg.author?.id;
		const displayName = resolveDisplayName(authorId, members);
		const text = extractTextFromMessage(msg);
		return `<helmor-room-message author="${escapeAttribute(displayName)}">${escapeText(text)}</helmor-room-message>`;
	});

	const block = [
		"<helmor-room-context>",
		"The following messages were sent by teammates in the shared room since the last agent turn. They provide context for this request.",
		...lines,
		"</helmor-room-context>",
	].join("\n");

	return { block, count: collected.length };
}
