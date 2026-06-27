import type { ThreadMessageLike } from "@/lib/api";
import type { ComposerContentPart } from "./editor-ops";

export type InputHistoryPart = Extract<
	ComposerContentPart,
	{ kind: "text" | "image" | "file" }
>;

export type InputHistoryEntry = {
	parts: InputHistoryPart[];
};

const IMAGE_EXT_RE =
	/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)(\?.*)?$/i;

function isImagePath(path: string): boolean {
	return IMAGE_EXT_RE.test(path);
}

function entryFromUserMessage(
	message: ThreadMessageLike,
): InputHistoryEntry | null {
	const parts: InputHistoryPart[] = [];
	for (const part of message.content) {
		if (part.type === "text" && part.text) {
			parts.push({ kind: "text", text: part.text });
		} else if (part.type === "file-mention") {
			parts.push({
				kind: isImagePath(part.path) ? "image" : "file",
				path: part.path,
			});
		}
	}
	if (parts.length === 0) return null;
	return { parts };
}

function historyKey(entry: InputHistoryEntry): string {
	return JSON.stringify(entry.parts);
}

export function inputHistoryEntryText(entry: InputHistoryEntry): string {
	return entry.parts
		.map((part) => (part.kind === "text" ? part.text : `@${part.path}`))
		.join("");
}

/**
 * Build the recall list for a session. Most-recent prompt first.
 *
 * Consecutive duplicates are collapsed (matching shell behaviour).
 */
export function extractInputHistoryFromThread(
	thread: readonly ThreadMessageLike[] | undefined,
): InputHistoryEntry[] {
	if (!thread || thread.length === 0) return [];
	const entries: InputHistoryEntry[] = [];
	let lastKey: string | null = null;
	for (let i = thread.length - 1; i >= 0; i--) {
		const message = thread[i];
		if (message?.role !== "user") continue;
		const entry = entryFromUserMessage(message);
		if (!entry) continue;
		const key = historyKey(entry);
		if (key === lastKey) continue;
		lastKey = key;
		entries.push(entry);
	}
	return entries;
}
