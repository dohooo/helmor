import { describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import {
	extractInputHistoryFromThread,
	inputHistoryEntryText,
} from "./input-history";

function userMsg(
	id: string,
	text: string,
	mentions: string[] = [],
): ThreadMessageLike {
	const content: ThreadMessageLike["content"] = [];
	if (text) {
		content.push({ type: "text", id: `${id}:txt`, text });
	}
	mentions.forEach((path, index) => {
		content.push({ type: "file-mention", id: `${id}:m:${index}`, path });
	});
	return { role: "user", id, content };
}

function assistantMsg(id: string): ThreadMessageLike {
	return {
		role: "assistant",
		id,
		content: [{ type: "text", id: `${id}:txt`, text: "ack" }],
	};
}

describe("extractInputHistoryFromThread", () => {
	it("returns an empty array for an undefined or empty thread", () => {
		expect(extractInputHistoryFromThread(undefined)).toEqual([]);
		expect(extractInputHistoryFromThread([])).toEqual([]);
	});

	it("returns user messages newest-first and skips non-user roles", () => {
		const thread: ThreadMessageLike[] = [
			userMsg("u1", "hello"),
			assistantMsg("a1"),
			userMsg("u2", "second"),
			assistantMsg("a2"),
			userMsg("u3", "third"),
		];
		const history = extractInputHistoryFromThread(thread);
		expect(history.map(inputHistoryEntryText)).toEqual([
			"third",
			"second",
			"hello",
		]);
	});

	it("classifies file-mention paths into images vs files by extension", () => {
		const thread: ThreadMessageLike[] = [
			userMsg("u1", "look at ", [
				"/abs/screenshot.PNG",
				"/abs/notes.md",
				"/abs/photo.jpeg",
				"/abs/diagram.svg",
				"/abs/script.ts",
			]),
		];
		const [entry] = extractInputHistoryFromThread(thread);
		expect(entry).toBeDefined();
		const images =
			entry?.parts
				.filter((part) => part.kind === "image")
				.map((part) => part.path) ?? [];
		const files =
			entry?.parts
				.filter((part) => part.kind === "file")
				.map((part) => part.path) ?? [];
		expect(images.sort()).toEqual(
			["/abs/diagram.svg", "/abs/photo.jpeg", "/abs/screenshot.PNG"].sort(),
		);
		expect(files.sort()).toEqual(["/abs/notes.md", "/abs/script.ts"].sort());
	});

	it("preserves the original prompt order as parts", () => {
		const thread: ThreadMessageLike[] = [
			{
				role: "user",
				id: "u1",
				content: [
					{ type: "text", id: "u1:t0", text: "fix " },
					{ type: "file-mention", id: "u1:m0", path: "src/foo.ts" },
					{ type: "text", id: "u1:t1", text: " please" },
				],
			},
		];
		const [entry] = extractInputHistoryFromThread(thread);
		expect(entry?.parts).toEqual([
			{ kind: "text", text: "fix " },
			{ kind: "file", path: "src/foo.ts" },
			{ kind: "text", text: " please" },
		]);
		expect(entry ? inputHistoryEntryText(entry) : "").toBe(
			"fix @src/foo.ts please",
		);
	});

	it("collapses consecutive duplicate prompts", () => {
		const thread: ThreadMessageLike[] = [
			userMsg("u1", "ls"),
			assistantMsg("a1"),
			userMsg("u2", "ls"),
			assistantMsg("a2"),
			userMsg("u3", "ls"),
			assistantMsg("a3"),
			userMsg("u4", "cd"),
		];
		const history = extractInputHistoryFromThread(thread);
		expect(history.map(inputHistoryEntryText)).toEqual(["cd", "ls"]);
	});

	it("preserves repeated mention parts within a single entry", () => {
		const thread: ThreadMessageLike[] = [
			userMsg("u1", "look at ", ["src/a.ts", "src/a.ts", "src/b.ts"]),
		];
		const [entry] = extractInputHistoryFromThread(thread);
		expect(entry?.parts).toEqual([
			{ kind: "text", text: "look at " },
			{ kind: "file", path: "src/a.ts" },
			{ kind: "file", path: "src/a.ts" },
			{ kind: "file", path: "src/b.ts" },
		]);
	});

	it("skips empty user messages (no text and no mentions)", () => {
		const thread: ThreadMessageLike[] = [
			userMsg("u1", "hi"),
			{ role: "user", id: "u2", content: [] },
			userMsg("u3", "there"),
		];
		const history = extractInputHistoryFromThread(thread);
		expect(history.map(inputHistoryEntryText)).toEqual(["there", "hi"]);
	});
});
