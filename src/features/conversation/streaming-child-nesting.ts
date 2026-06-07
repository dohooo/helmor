import type { ExtendedMessagePart, ThreadMessageLike } from "@/lib/api";

/**
 * Live nesting of a subagent's streaming partial.
 *
 * Finalized subagent turns are folded under their parent `Task`/`Agent`/
 * `Workflow` tool call by the Rust grouping pass (`child:<parent>:<id>`).
 * The streaming partial carries the same `child:` id, but on its own it has
 * no parent to attach to — so without this it would flash as a separate
 * top-level assistant bubble and then "jump" into the card on finalize.
 *
 * Here we splice the partial's content into the matching tool call's
 * `children` so the live tokens render inside the card from the first frame.
 * Returns a new array (cloned only along the path to the touched tool call)
 * or `null` when the partial isn't a child or no parent tool call is found —
 * the caller then falls back to the normal top-level streaming path.
 */
export function nestStreamingChildPartial(
	baseMessages: ThreadMessageLike[],
	partial: ThreadMessageLike,
): ThreadMessageLike[] | null {
	const parentToolId = parseChildParent(partial.id);
	if (!parentToolId) {
		return null;
	}

	// Walk newest-first: the parent tool call is almost always near the tail.
	for (let mi = baseMessages.length - 1; mi >= 0; mi -= 1) {
		const msg = baseMessages[mi]!;
		const nextContent = injectIntoToolCall(
			msg.content,
			parentToolId,
			partial.content,
		);
		if (nextContent) {
			const out = baseMessages.slice();
			out[mi] = { ...msg, content: nextContent };
			return out;
		}
	}
	return null;
}

/** Extract `<parent>` from a `child:<parent>:<id>` message id. */
function parseChildParent(id: string | undefined): string | null {
	if (!id?.startsWith("child:")) {
		return null;
	}
	const rest = id.slice("child:".length);
	const sep = rest.indexOf(":");
	return sep > 0 ? rest.slice(0, sep) : null;
}

/**
 * Find the tool call with `toolCallId === parentId` (recursing into nested
 * children so an `Agent` spawned under a `Workflow` still matches) and append
 * the partial's parts to its `children`. Returns a new content array with only
 * the path to the touched tool call cloned, or `null` if not found.
 */
function injectIntoToolCall(
	content: ExtendedMessagePart[],
	parentId: string,
	childParts: ExtendedMessagePart[],
): ExtendedMessagePart[] | null {
	for (let i = 0; i < content.length; i += 1) {
		const part = content[i]!;
		if (part.type !== "tool-call") {
			continue;
		}
		if (part.toolCallId === parentId) {
			const out = content.slice();
			out[i] = {
				...part,
				children: [...(part.children ?? []), ...childParts],
			};
			return out;
		}
		if (part.children && part.children.length > 0) {
			const nested = injectIntoToolCall(part.children, parentId, childParts);
			if (nested) {
				const out = content.slice();
				out[i] = { ...part, children: nested };
				return out;
			}
		}
	}
	return null;
}
