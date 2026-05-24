// GitLab provider — thin wrapper over the Rust `forge.*` host bridge.
// Mirrors github.ts; backend dispatch keys on provider="gitlab".

import { Type } from "@earendil-works/pi-ai";

import { callHost } from "../../host-bridge";
import type { ProviderContext, TriageProvider } from "./types";

const now = () => new Date().toISOString();
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);

interface InboxPage {
	items: InboxItem[];
	nextCursor: string | null;
}
interface InboxItem {
	id?: string;
	source?: string;
	externalId?: string;
	title?: string;
	subtitle?: string | null;
	state?: string | null;
	lastActivityAt?: string | null;
	url?: string | null;
}

let DISCOVERED_LOGIN: string | null = null;

async function getLogin(): Promise<string> {
	if (DISCOVERED_LOGIN) return DISCOVERED_LOGIN;
	const r = await callHost<{ login: string | null }>("forge.discover_login", {
		provider: "gitlab",
	});
	if (!r.login)
		throw new Error("No GitLab account connected. Run `glab auth login`.");
	DISCOVERED_LOGIN = r.login;
	return DISCOVERED_LOGIN;
}

function renderItems(items: InboxItem[], kind: "issue" | "mr"): string {
	const sigil = kind === "issue" ? "#" : "!";
	const out: string[] = [];
	for (const it of items) {
		out.push(
			`## ${sigil}${it.externalId ?? "?"} — ${it.title ?? "(no title)"}`,
		);
		if (it.state) out.push(`- state: ${it.state}`);
		if (it.lastActivityAt) out.push(`- updated: ${it.lastActivityAt}`);
		if (it.url) out.push(`- url: ${it.url}`);
		if (it.subtitle) out.push(`- subtitle: ${it.subtitle}`);
		out.push("", "---", "");
	}
	return out.join("\n");
}

function buildTools({ scratch }: ProviderContext): unknown[] {
	const listInbox = (
		kind: "Issues" | "Prs",
		toolName: string,
		label: string,
		description: string,
	) => ({
		name: toolName,
		label,
		description,
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ description: "1-100, default 30." })),
		}),
		execute: async (_id: string, params: { limit?: number }) => {
			const login = await getLogin();
			const page = await callHost<InboxPage>("forge.list_inbox_items", {
				provider: "gitlab",
				kind,
				login,
				limit: params.limit ?? 30,
			});
			const items = page.items ?? [];
			const file = await scratch.write(
				`gitlab_${kind === "Issues" ? "issues" : "mrs"}.md`,
				`# GitLab inbox · ${kind === "Issues" ? "issues" : "mrs"}\nlogin: ${login}\nfetched_at: ${now()}\ncount: ${items.length}\n\n---\n\n${renderItems(items, kind === "Issues" ? "issue" : "mr")}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${items.length} ${kind === "Issues" ? "issue" : "MR"}(s) to scratch/${file}.`,
					},
				],
				details: { file, count: items.length },
			};
		},
	});

	const viewItem = (
		source: "gitlab_issue" | "gitlab_mr",
		toolName: string,
		label: string,
	) => ({
		name: toolName,
		label,
		description: `Fetch one ${source === "gitlab_issue" ? "issue" : "MR"}'s native detail (body + comments).`,
		parameters: Type.Object({
			external_id: Type.String({
				description: "External id from the inbox item (the iid).",
			}),
		}),
		execute: async (_id: string, params: { external_id: string }) => {
			const login = await getLogin();
			const detail = await callHost<unknown>("forge.get_inbox_item_detail", {
				provider: "gitlab",
				login,
				source,
				externalId: params.external_id,
			});
			const json = JSON.stringify(detail, null, 2);
			const file = await scratch.write(
				`gitlab_${source}_${safe(params.external_id)}.md`,
				`# GitLab ${source} ${params.external_id}\nfetched_at: ${now()}\n\n---\n\n\`\`\`json\n${json}\n\`\`\`\n`,
			);
			return {
				content: [
					{ type: "text" as const, text: `Wrote detail to scratch/${file}.` },
				],
				details: { file },
			};
		},
	});

	return [
		listInbox(
			"Issues",
			"gitlab_inbox_issues",
			"GitLab · Inbox Issues",
			"List GitLab issues in your inbox (assigned / mentioning you).",
		),
		listInbox(
			"Prs",
			"gitlab_inbox_mrs",
			"GitLab · Inbox MRs",
			"List GitLab MRs in your inbox (assigned / review-requested).",
		),
		viewItem("gitlab_issue", "gitlab_view_issue", "GitLab · View Issue"),
		viewItem("gitlab_mr", "gitlab_view_mr", "GitLab · View MR"),
	];
}

export const gitlabProvider: TriageProvider = {
	id: "gitlab",
	displayName: "GitLab",
	description:
		"Scans your GitLab inbox (issues/MRs). Sign in with `glab auth login`.",
	async preflight() {
		try {
			DISCOVERED_LOGIN = null;
			await getLogin();
			return { ok: true };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, reason: msg };
		}
	},
	buildTools,
	promptHint() {
		return `## GitLab
Use gitlab_inbox_issues / gitlab_inbox_mrs to scan items the user is assigned / mentioned on. Drill into one item via gitlab_view_issue / gitlab_view_mr with its external_id (the iid).`;
	},
};
