// GitHub provider — thin wrapper over the Rust `forge.*` host bridge.
// We reuse the same `list_inbox_items` / `get_inbox_item_detail` surfaces
// the rest of Helmor (inbox UI etc.) consumes, so triage never duplicates
// gh-CLI parsing logic.

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
		provider: "github",
	});
	if (!r.login)
		throw new Error("No GitHub account connected. Run `gh auth login`.");
	DISCOVERED_LOGIN = r.login;
	return DISCOVERED_LOGIN;
}

function renderItems(items: InboxItem[], kind: "issue" | "pr"): string {
	const out: string[] = [];
	const sigil = kind === "issue" ? "#" : "PR ";
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
				provider: "github",
				kind,
				login,
				limit: params.limit ?? 30,
			});
			const items = page.items ?? [];
			const file = await scratch.write(
				`github_${kind.toLowerCase()}.md`,
				`# GitHub inbox · ${kind.toLowerCase()}\nlogin: ${login}\nfetched_at: ${now()}\ncount: ${items.length}\n\n---\n\n${renderItems(items, kind === "Issues" ? "issue" : "pr")}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${items.length} ${kind.toLowerCase()} to scratch/${file}.`,
					},
				],
				details: { file, count: items.length },
			};
		},
	});

	const viewItem = (
		source: "github_issue" | "github_pr",
		toolName: string,
		label: string,
	) => ({
		name: toolName,
		label,
		description: `Fetch one ${source === "github_issue" ? "issue" : "PR"}'s native detail (body + comments).`,
		parameters: Type.Object({
			external_id: Type.String({
				description:
					"External id from the inbox item (e.g. the issue/PR number).",
			}),
		}),
		execute: async (_id: string, params: { external_id: string }) => {
			const login = await getLogin();
			const detail = await callHost<unknown>("forge.get_inbox_item_detail", {
				provider: "github",
				login,
				source,
				externalId: params.external_id,
			});
			const json = JSON.stringify(detail, null, 2);
			const file = await scratch.write(
				`github_${source}_${safe(params.external_id)}.md`,
				`# GitHub ${source} ${params.external_id}\nfetched_at: ${now()}\n\n---\n\n\`\`\`json\n${json}\n\`\`\`\n`,
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
			"github_inbox_issues",
			"GitHub · Inbox Issues",
			"List GitHub issues in your inbox (assigned / mentioning you).",
		),
		listInbox(
			"Prs",
			"github_inbox_prs",
			"GitHub · Inbox PRs",
			"List GitHub PRs in your inbox (assigned / review-requested).",
		),
		viewItem("github_issue", "github_view_issue", "GitHub · View Issue"),
		viewItem("github_pr", "github_view_pr", "GitHub · View PR"),
	];
}

export const githubProvider: TriageProvider = {
	id: "github",
	displayName: "GitHub",
	description:
		"Scans your GitHub inbox (assigned issues / PRs). Sign in with `gh auth login`.",
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
		return `## GitHub
Use github_inbox_issues / github_inbox_prs to scan items the user is assigned / @-mentioned / review-requested on. Drill into one item via github_view_issue / github_view_pr with its external_id (the number).`;
	},
};
