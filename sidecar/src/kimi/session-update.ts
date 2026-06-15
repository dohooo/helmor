/**
 * Pure helpers translating ACP wire shapes ↔ Helmor's namespaced `kimi/*`
 * passthrough events + prompt content blocks. Keeping this side-effect-free
 * makes the manager thin and these mappings unit-testable in isolation.
 *
 * The `kimi/*` event shapes here are an internal contract: the Rust
 * accumulator (`pipeline/accumulator/kimi.rs`) consumes exactly these fields.
 * ACP's tool-call `content`/`diff` blocks are flattened TS-side so Rust only
 * has to render a clean shape.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { imageMime } from "../images.js";
import type { SlashCommandInfo } from "../session-manager.js";
import type {
	AcpContentBlock,
	AcpPermissionOption,
	AcpSessionUpdate,
} from "./acp-types.js";

/** Build an ACP `prompt: ContentBlock[]` from the composer's text + images. */
export async function buildPromptBlocks(
	prompt: string,
	images: readonly string[],
): Promise<AcpContentBlock[]> {
	const blocks: AcpContentBlock[] = [];
	if (prompt.trim().length > 0) blocks.push({ type: "text", text: prompt });
	for (const path of images) {
		try {
			const data = (await readFile(path)).toString("base64");
			blocks.push({ type: "image", data, mimeType: imageMime(path) });
		} catch {
			// A missing/unreadable image must not abort the turn; mention it inline.
			blocks.push({
				type: "text",
				text: `[image unavailable: ${basename(path)}]`,
			});
		}
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: prompt });
	return blocks;
}

/** Flatten an ACP `ContentBlock` to plain text (text/resource only). */
export function contentBlockToText(block: AcpContentBlock | undefined): string {
	if (!block || typeof block !== "object") return "";
	if (block.type === "text" && typeof block.text === "string")
		return block.text;
	if (block.type === "resource") {
		const resource = (block as { resource?: { text?: unknown } }).resource;
		if (resource && typeof resource.text === "string") return resource.text;
	}
	if (block.type === "resource_link") {
		const link = block as { title?: unknown; uri?: unknown };
		if (typeof link.title === "string") return link.title;
		if (typeof link.uri === "string") return link.uri;
	}
	return "";
}

interface ToolDiff {
	readonly path: string;
	readonly old_text?: string;
	readonly new_text: string;
}

/** Flatten ACP `ToolCall.content[]` to { outputText, diffs }. */
function extractToolContent(content: unknown): {
	outputText: string;
	diffs: ToolDiff[];
} {
	const texts: string[] = [];
	const diffs: ToolDiff[] = [];
	if (Array.isArray(content)) {
		for (const item of content) {
			if (!item || typeof item !== "object") continue;
			const entry = item as Record<string, unknown>;
			if (entry.type === "content") {
				texts.push(contentBlockToText(entry.content as AcpContentBlock));
			} else if (entry.type === "diff" && typeof entry.path === "string") {
				diffs.push({
					path: entry.path,
					...(typeof entry.oldText === "string"
						? { old_text: entry.oldText }
						: {}),
					new_text: typeof entry.newText === "string" ? entry.newText : "",
				});
			}
		}
	}
	return { outputText: texts.filter(Boolean).join("\n"), diffs };
}

/** Flatten ACP `ToolCallContent[]` to plain text (permission prompt body). */
export function toolContentText(content: unknown): string {
	return extractToolContent(content).outputText;
}

/**
 * A `session/request_permission` whose options repeat a `kind` is not a
 * binary approval: Kimi reuses the permission channel for AskUserQuestion
 * (one `allow_once` per answer + a `reject_once` Skip) and plan review
 * (N×`allow_once` + `Revise`/`Reject and Exit`, both `reject_once`). The
 * canonical tool approval carries each kind at most once, so kind
 * multiplicity is the discriminator — those requests must surface every
 * option to the user instead of being flattened to Allow/Deny.
 */
export function isSelectionRequest(
	options: readonly AcpPermissionOption[],
): boolean {
	const seen = new Set<string>();
	for (const option of options) {
		const kind = option.kind ?? "";
		if (seen.has(kind)) return true;
		seen.add(kind);
	}
	return false;
}

/** Pull the selected label out of an AUQ submit payload
 *  (`{ answers: { [question]: "label" } }`, single-select). */
export function firstAnswerLabel(
	content: Record<string, unknown> | undefined,
): string | null {
	const answers = content?.answers;
	if (!answers || typeof answers !== "object") return null;
	const first = Object.values(answers as Record<string, unknown>)[0];
	if (typeof first !== "string") return null;
	const label = first.split(",")[0]?.trim() ?? "";
	return label.length > 0 ? label : null;
}

function toolEvent(
	type: "kimi/tool_call" | "kimi/tool_call_update",
	sessionId: string,
	update: AcpSessionUpdate,
): Record<string, unknown> {
	const { outputText, diffs } = extractToolContent(update.content);
	const event: Record<string, unknown> = {
		type,
		session_id: sessionId,
		tool_call_id: update.toolCallId ?? "",
	};
	if (typeof update.title === "string") event.title = update.title;
	if (typeof update.kind === "string") event.kind = update.kind;
	if (typeof update.status === "string") event.status = update.status;
	if (update.rawInput !== undefined) event.raw_input = update.rawInput;
	if (outputText) event.output_text = outputText;
	if (diffs.length > 0) event.diffs = diffs;
	return event;
}

export interface TranslatedUpdate {
	/** Forward verbatim to the Rust accumulator (namespaced `kimi/*`). */
	readonly passthrough?: Record<string, unknown>;
	/** `available_commands_update` → cache for the slash-command popup. */
	readonly commands?: SlashCommandInfo[];
}

/**
 * Map one ACP `session/update` to a namespaced passthrough event and/or a
 * side-channel action. Returns `{}` for updates Helmor ignores (e.g. the
 * user-message echo, mode/config/session-info updates).
 */
export function translateSessionUpdate(
	sessionId: string,
	update: AcpSessionUpdate,
): TranslatedUpdate {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return {
				passthrough: {
					type: "kimi/agent_message_chunk",
					session_id: sessionId,
					text: contentBlockToText(update.content as AcpContentBlock),
				},
			};
		case "agent_thought_chunk":
			return {
				passthrough: {
					type: "kimi/agent_thought_chunk",
					session_id: sessionId,
					text: contentBlockToText(update.content as AcpContentBlock),
				},
			};
		case "tool_call":
			return { passthrough: toolEvent("kimi/tool_call", sessionId, update) };
		case "tool_call_update":
			return {
				passthrough: toolEvent("kimi/tool_call_update", sessionId, update),
			};
		case "plan":
			return {
				passthrough: {
					type: "kimi/plan",
					session_id: sessionId,
					entries: (update.entries ?? []).map((e) => ({
						content: typeof e.content === "string" ? e.content : "",
						priority: typeof e.priority === "string" ? e.priority : "medium",
						status: typeof e.status === "string" ? e.status : "pending",
					})),
				},
			};
		case "available_commands_update":
			return {
				commands: (update.availableCommands ?? [])
					.map((c) => ({
						name: (c.name ?? "").trim(),
						description: (c.description ?? "").trim(),
						argumentHint: undefined,
						source: "builtin" as const,
					}))
					.filter((c) => c.name.length > 0),
			};
		default:
			// user_message_chunk (echo), current_mode_update, config_option_update,
			// session_info_update, usage_update — nothing to render in v1.
			return {};
	}
}
