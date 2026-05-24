// Lark provider — thin wrapper over the Rust `lark.*` host bridge.
// The Rust side handles the `lark-cli` shell-out; we just shape the
// markdown the agent sees in scratch.

import { Type } from "@earendil-works/pi-ai";

import { callHost } from "../../host-bridge";
import type { ProviderContext, TriageProvider } from "./types";

const now = () => new Date().toISOString();
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

interface ChatRecord {
	chat_id?: string;
	name?: string;
	chat_mode?: string;
	external?: boolean;
	owner_id?: string;
	description?: string;
}

interface MessageRecord {
	message_id?: string;
	chat_id?: string;
	chat_name?: string;
	msg_type?: string;
	create_time?: string;
	content?: string;
	deleted?: boolean;
	message_app_link?: string;
	sender?: { id?: string; name?: string };
}

function renderChats(chats: ChatRecord[]): string {
	const out: string[] = [];
	for (const c of chats) {
		out.push(`## ${c.name ?? "(unnamed)"}`);
		out.push(`- chat_id: ${c.chat_id ?? ""}`);
		if (c.chat_mode) out.push(`- mode: ${c.chat_mode}`);
		if (typeof c.external === "boolean") out.push(`- external: ${c.external}`);
		if (c.owner_id) out.push(`- owner: ${c.owner_id}`);
		if (c.description)
			out.push(
				`- description: ${c.description.replace(/\s+/g, " ").slice(0, 200)}`,
			);
		out.push("", "---", "");
	}
	return out.join("\n");
}

function renderMessages(messages: MessageRecord[]): string {
	const out: string[] = [];
	for (const m of messages) {
		const sender = m.sender ?? {};
		out.push(`## ${m.message_id ?? "(no id)"}`);
		out.push(
			`- sender: ${sender.name ?? sender.id ?? "(unknown)"} (${sender.id ?? ""})`,
		);
		if (m.chat_id)
			out.push(`- chat: ${m.chat_name ?? ""} (${m.chat_id})`.trim());
		if (m.create_time) out.push(`- time: ${m.create_time}`);
		if (m.msg_type) out.push(`- type: ${m.msg_type}`);
		if (m.message_app_link) out.push(`- link: ${m.message_app_link}`);
		if (m.deleted) out.push(`- deleted: true`);
		out.push("", "```", String(m.content ?? "").trim(), "```", "", "---", "");
	}
	return out.join("\n");
}

function buildTools({ scratch, lastTriagedAt }: ProviderContext): unknown[] {
	const hintStart = lastTriagedAt
		? `Use start="${lastTriagedAt}" to only get items after last triage.`
		: "First run — no time floor.";

	const chatSearch = {
		name: "lark_chat_search",
		label: "Lark · Search Chats",
		description: "Search visible group chats by keyword. Writes to scratch.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Keyword (max 64 chars)." }),
			),
			member_ids: Type.Optional(
				Type.String({ description: "Member open_ids, comma-separated." }),
			),
			page_size: Type.Optional(
				Type.Integer({ description: "1-100, default 50." }),
			),
		}),
		execute: async (
			_id: string,
			params: { query?: string; member_ids?: string; page_size?: number },
		) => {
			const json = await callHost<{ data?: { chats?: ChatRecord[] } }>(
				"lark.chat_search",
				{
					query: params.query,
					memberIds: params.member_ids,
					pageSize: params.page_size ?? 50,
				},
			);
			const chats = json.data?.chats ?? [];
			const file = await scratch.write(
				`lark_chats_${safe(params.query || params.member_ids || "all")}.md`,
				`# Lark chat-search\nfetched_at: ${now()}\ncount: ${chats.length}\n\n---\n\n${renderChats(chats)}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${chats.length} chat(s) to scratch/${file}.`,
					},
				],
				details: { file, count: chats.length },
			};
		},
	};

	const chatMessages = {
		name: "lark_chat_messages_list",
		label: "Lark · Chat Messages",
		description: `List recent messages in one chat (newest first). ${hintStart}`,
		parameters: Type.Object({
			chat_id: Type.String({ description: "open_chat_id (oc_xxx)." }),
			page_size: Type.Optional(
				Type.Integer({ description: "1-50, default 50." }),
			),
			start: Type.Optional(
				Type.String({ description: "ISO 8601 lower bound." }),
			),
		}),
		execute: async (
			_id: string,
			params: { chat_id: string; page_size?: number; start?: string },
		) => {
			const start = params.start?.trim() || lastTriagedAt;
			const json = await callHost<{ data?: { messages?: MessageRecord[] } }>(
				"lark.chat_messages_list",
				{
					chatId: params.chat_id,
					pageSize: params.page_size ?? 50,
					start,
				},
			);
			const messages = json.data?.messages ?? [];
			const file = await scratch.write(
				`lark_chat-msgs_${safe(params.chat_id)}.md`,
				`# Lark chat-messages-list\nchat_id: ${params.chat_id}\nstart: ${start ?? ""}\nfetched_at: ${now()}\ncount: ${messages.length}\n\n---\n\n${renderMessages(messages)}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${messages.length} message(s) to scratch/${file}.`,
					},
				],
				details: { file, count: messages.length },
			};
		},
	};

	const messagesSearch = {
		name: "lark_messages_search",
		label: "Lark · Search Messages",
		description: `Search messages with filters (sender/keyword/chat/@me/time). ${hintStart}`,
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Keyword filter." })),
			sender: Type.Optional(
				Type.String({ description: "Sender open_ids, comma-separated." }),
			),
			chat_id: Type.Optional(
				Type.String({ description: "Chat ids, comma-separated." }),
			),
			is_at_me: Type.Optional(
				Type.Boolean({ description: "Only @me messages." }),
			),
			start: Type.Optional(
				Type.String({ description: "ISO 8601 lower bound." }),
			),
			end: Type.Optional(Type.String({ description: "ISO 8601 upper bound." })),
			page_size: Type.Optional(
				Type.Integer({ description: "1-50, default 50." }),
			),
		}),
		execute: async (
			_id: string,
			params: {
				query?: string;
				sender?: string;
				chat_id?: string;
				is_at_me?: boolean;
				start?: string;
				end?: string;
				page_size?: number;
			},
		) => {
			const start = params.start?.trim() || lastTriagedAt;
			const json = await callHost<{ data?: { messages?: MessageRecord[] } }>(
				"lark.messages_search",
				{
					query: params.query,
					sender: params.sender,
					chatId: params.chat_id,
					isAtMe: params.is_at_me ?? false,
					start,
					end: params.end,
					pageSize: params.page_size ?? 50,
				},
			);
			const messages = json.data?.messages ?? [];
			const key = safe(
				params.sender ?? params.query ?? params.chat_id ?? "all",
			);
			const file = await scratch.write(
				`lark_search_${key}.md`,
				`# Lark messages-search\nquery: ${params.query ?? ""}\nsender: ${params.sender ?? ""}\nchat_id: ${params.chat_id ?? ""}\nstart: ${start ?? ""}\nfetched_at: ${now()}\ncount: ${messages.length}\n\n---\n\n${renderMessages(messages)}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${messages.length} message(s) to scratch/${file}.`,
					},
				],
				details: { file, count: messages.length },
			};
		},
	};

	const saveImage = {
		name: "lark_save_image",
		label: "Lark · Save Image",
		description:
			"Download a Lark message image (msg_type=image) into staging so it can be attached to a propose_workspace call. Returns an attachment id — pass it in propose_workspace.attachments. You don't need to look at the image yourself; the workspace's vision-capable agent will.",
		parameters: Type.Object({
			message_id: Type.String({ description: "om_ message id." }),
			image_key: Type.String({
				description:
					"img_ key from the message content (post-type messages embed it as image_key).",
			}),
			extension: Type.Optional(
				Type.String({
					description: "Override filename extension (default png).",
				}),
			),
		}),
		execute: async (
			_id: string,
			params: { message_id: string; image_key: string; extension?: string },
		) => {
			const r = await callHost<{
				id: string;
				filename: string;
				sizeBytes: number;
			}>("lark.save_image", {
				tickId: scratch.tickId,
				messageId: params.message_id,
				imageKey: params.image_key,
				extension: params.extension,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Saved Lark image as attachment ${r.id} (${r.filename}, ${r.sizeBytes} bytes).`,
					},
				],
				details: r,
			};
		},
	};

	const messagesGet = {
		name: "lark_messages_get",
		label: "Lark · Get Messages",
		description: "Fetch full body of one or more messages by id.",
		parameters: Type.Object({
			message_ids: Type.String({
				description: "Comma-separated om_ ids (up to 50).",
			}),
		}),
		execute: async (_id: string, params: { message_ids: string }) => {
			const json = await callHost<{ data?: { messages?: MessageRecord[] } }>(
				"lark.messages_get",
				{ messageIds: params.message_ids.trim() },
			);
			const messages = json.data?.messages ?? [];
			const file = await scratch.write(
				`lark_msg-batch_${safe(params.message_ids.split(",")[0] ?? "batch")}.md`,
				`# Lark messages-mget\nfetched_at: ${now()}\ncount: ${messages.length}\n\n---\n\n${renderMessages(messages)}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${messages.length} message(s) to scratch/${file}.`,
					},
				],
				details: { file, count: messages.length },
			};
		},
	};

	return [chatSearch, chatMessages, messagesSearch, messagesGet, saveImage];
}

export const larkProvider: TriageProvider = {
	id: "lark",
	displayName: "Lark / Feishu",
	description:
		"Scans messages via lark-cli. Sign in with `lark-cli auth login`.",
	async preflight() {
		try {
			await callHost<unknown>("lark.auth_status");
			return { ok: true };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				ok: false,
				reason: `lark-cli not authenticated. ${msg}`,
			};
		}
	},
	buildTools,
	promptHint({ lastTriagedAt }) {
		return `## Lark / Feishu
Use lark_* tools to scan messages. ${
			lastTriagedAt
				? `Only look at items after \`${lastTriagedAt}\` (use \`start=\` on search/list).`
				: "First run — no time floor."
		}`;
	},
};
