// Slack provider — thin wrapper over the Rust slack host bridge.
// Multi-workspace by design: the agent first calls slack_list_workspaces
// to enumerate connected teams, then keys every subsequent call on the
// chosen team_id.

import { Type } from "@earendil-works/pi-ai";

import { callHost } from "../../host-bridge";
import type { ProviderContext, TriageProvider } from "./types";

const now = () => new Date().toISOString();
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);

interface SlackWorkspace {
	teamId: string;
	teamName: string;
	teamDomain: string;
	myUserId: string;
}

interface InboxPage {
	items: InboxItem[];
	nextCursor: string | null;
}

interface InboxItem {
	id?: string;
	channelId?: string;
	channelName?: string | null;
	permalink?: string | null;
	text?: string | null;
	user?: string | null;
	ts?: string | null;
	threadTs?: string | null;
}

function renderItems(items: InboxItem[]): string {
	const out: string[] = [];
	for (const it of items) {
		out.push(`## ${it.channelName ?? "?"} — ${it.ts ?? "(no ts)"}`);
		if (it.user) out.push(`- user: ${it.user}`);
		if (it.permalink) out.push(`- link: ${it.permalink}`);
		if (it.channelId) out.push(`- channel_id: ${it.channelId}`);
		if (it.threadTs) out.push(`- thread_ts: ${it.threadTs}`);
		if (it.ts) out.push(`- ts: ${it.ts}`);
		if (it.text?.trim()) {
			out.push("", "```", it.text.trim(), "```");
		}
		out.push("", "---", "");
	}
	return out.join("\n");
}

function buildTools({ scratch }: ProviderContext): unknown[] {
	const saveAttachment = {
		name: "slack_save_attachment",
		label: "Slack · Save Attachment",
		description:
			"Download a Slack file (image/gif/etc) into staging so it can be attached to a propose_workspace call. Pass the returned id in propose_workspace.attachments. Hand off to the workspace agent; you don't need to interpret the file content.",
		parameters: Type.Object({
			url: Type.String({
				description:
					"url_private or permalink from a Slack file blob (e.g. files.slack.com/...).",
			}),
		}),
		execute: async (_id: string, params: { url: string }) => {
			const r = await callHost<{
				id: string;
				filename: string;
				sizeBytes: number;
			}>("slack.save_attachment", {
				tickId: scratch.tickId,
				url: params.url,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Saved Slack file as attachment ${r.id} (${r.filename}, ${r.sizeBytes} bytes).`,
					},
				],
				details: r,
			};
		},
	};
	const listWorkspaces = {
		name: "slack_list_workspaces",
		label: "Slack · List Workspaces",
		description:
			"List connected Slack workspaces. Returns team_id, team_name, team_domain. Call this first; pass team_id to other slack_* tools.",
		parameters: Type.Object({}),
		execute: async () => {
			const workspaces = await callHost<SlackWorkspace[]>(
				"slack.list_workspaces",
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(workspaces, null, 2) },
				],
				details: { count: workspaces.length },
			};
		},
	};

	const listInbox = {
		name: "slack_list_inbox",
		label: "Slack · Inbox",
		description:
			"List inbox items for one Slack workspace (unread / mentions / DMs).",
		parameters: Type.Object({
			team_id: Type.String({
				description: "Slack team_id (from slack_list_workspaces).",
			}),
			limit: Type.Optional(Type.Integer({ description: "1-100, default 30." })),
		}),
		execute: async (
			_id: string,
			params: { team_id: string; limit?: number },
		) => {
			const page = await callHost<InboxPage>("slack.list_inbox", {
				teamId: params.team_id,
				limit: params.limit ?? 30,
			});
			const items = page.items ?? [];
			const file = await scratch.write(
				`slack_inbox_${safe(params.team_id)}.md`,
				`# Slack inbox\nteam: ${params.team_id}\nfetched_at: ${now()}\ncount: ${items.length}\n\n---\n\n${renderItems(items)}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${items.length} inbox item(s) to scratch/${file}.`,
					},
				],
				details: { file, count: items.length },
			};
		},
	};

	const searchMessages = {
		name: "slack_search_messages",
		label: "Slack · Search Messages",
		description:
			"Search Slack messages by keyword in one workspace. Supports Slack search syntax (from:@user in:#channel).",
		parameters: Type.Object({
			team_id: Type.String({ description: "Slack team_id." }),
			query: Type.String({ description: "Search query." }),
			sort: Type.Optional(
				Type.String({ description: "newest | relevance, default newest." }),
			),
			limit: Type.Optional(Type.Integer({ description: "1-100, default 30." })),
		}),
		execute: async (
			_id: string,
			params: { team_id: string; query: string; sort?: string; limit?: number },
		) => {
			const page = await callHost<InboxPage>("slack.search_messages", {
				teamId: params.team_id,
				query: params.query,
				sort: params.sort,
				limit: params.limit ?? 30,
			});
			const items = page.items ?? [];
			const file = await scratch.write(
				`slack_search_${safe(params.team_id)}_${safe(params.query)}.md`,
				`# Slack search\nteam: ${params.team_id}\nquery: ${params.query}\nfetched_at: ${now()}\ncount: ${items.length}\n\n---\n\n${renderItems(items)}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${items.length} match(es) to scratch/${file}.`,
					},
				],
				details: { file, count: items.length },
			};
		},
	};

	const getThread = {
		name: "slack_get_thread",
		label: "Slack · Get Thread",
		description: "Fetch full thread (root + replies) for one message anchor.",
		parameters: Type.Object({
			team_id: Type.String(),
			channel_id: Type.String(),
			anchor_ts: Type.String({ description: "ts of the anchor message." }),
			thread_ts: Type.Optional(
				Type.String({ description: "Parent thread_ts if known." }),
			),
		}),
		execute: async (
			_id: string,
			params: {
				team_id: string;
				channel_id: string;
				anchor_ts: string;
				thread_ts?: string;
			},
		) => {
			const detail = await callHost<unknown>("slack.get_thread_detail", {
				teamId: params.team_id,
				channelId: params.channel_id,
				anchorTs: params.anchor_ts,
				threadTs: params.thread_ts,
			});
			const json = JSON.stringify(detail, null, 2);
			const file = await scratch.write(
				`slack_thread_${safe(params.channel_id)}_${safe(params.anchor_ts)}.md`,
				`# Slack thread\nteam: ${params.team_id}\nchannel: ${params.channel_id}\nanchor: ${params.anchor_ts}\nfetched_at: ${now()}\n\n---\n\n\`\`\`json\n${json}\n\`\`\`\n`,
			);
			return {
				content: [
					{ type: "text" as const, text: `Wrote thread to scratch/${file}.` },
				],
				details: { file },
			};
		},
	};

	return [listWorkspaces, listInbox, searchMessages, getThread, saveAttachment];
}

export const slackProvider: TriageProvider = {
	id: "slack",
	displayName: "Slack",
	description:
		"Scans Slack inbox / search across connected workspaces. Connect via Settings → Slack.",
	async preflight() {
		try {
			const workspaces = await callHost<SlackWorkspace[]>(
				"slack.list_workspaces",
			);
			if (!Array.isArray(workspaces) || workspaces.length === 0) {
				return {
					ok: false,
					reason:
						"No Slack workspace connected. Connect one in Settings → Slack first.",
				};
			}
			return { ok: true };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, reason: `Slack unavailable: ${msg}` };
		}
	},
	buildTools,
	promptHint() {
		return `## Slack
First call slack_list_workspaces to enumerate connected teams, then use slack_list_inbox / slack_search_messages with the chosen team_id. Drill into specific threads via slack_get_thread.`;
	},
};
