// GitHub provider — thin wrapper over the Rust `forge.*` host bridge.

import { Type } from "@earendil-works/pi-ai";

import { callHost } from "../../host-bridge";
import type { ProviderContext, TriageProvider } from "./types";
import { buildAttachmentContent } from "./types";

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

interface RepoItem {
	number?: number;
	title?: string;
	state?: string;
	author?: { login?: string } | null;
	assignees?: Array<{ login?: string } | null>;
	labels?: Array<{ name?: string } | null>;
	url?: string;
	updatedAt?: string;
	body?: string;
	isDraft?: boolean;
}

function renderRepoItems(items: RepoItem[], kind: "issue" | "pr"): string {
	const out: string[] = [];
	const sigil = kind === "issue" ? "#" : "PR ";
	for (const it of items) {
		out.push(`## ${sigil}${it.number ?? "?"} — ${it.title ?? "(no title)"}`);
		if (it.state) out.push(`- state: ${it.state}`);
		if (it.isDraft) out.push(`- draft: true`);
		if (it.author?.login) out.push(`- author: ${it.author.login}`);
		const assignees = (it.assignees ?? [])
			.map((a) => a?.login)
			.filter((s): s is string => !!s);
		if (assignees.length > 0) out.push(`- assignees: ${assignees.join(", ")}`);
		const labels = (it.labels ?? [])
			.map((l) => l?.name)
			.filter((s): s is string => !!s);
		if (labels.length > 0) out.push(`- labels: ${labels.join(", ")}`);
		if (it.updatedAt) out.push(`- updated: ${it.updatedAt}`);
		if (it.url) out.push(`- url: ${it.url}`);
		if (it.body?.trim()) out.push("", "```", it.body.trim(), "```");
		out.push("", "---", "");
	}
	return out.join("\n");
}

function buildTools({ scratch }: ProviderContext): unknown[] {
	const listRepoItems = (
		kind: "issues" | "prs",
		toolName: string,
		label: string,
	) => ({
		name: toolName,
		label,
		description:
			kind === "issues"
				? "List ALL open issues in a Helmor repo (not just yours). Use this to discover work the user might pick up — independent of GitHub inbox filters."
				: "List ALL open PRs in a Helmor repo (not just yours / not just review-requested).",
		parameters: Type.Object({
			repo_id: Type.String({
				description: "Helmor repo id from list_repos.",
			}),
			state: Type.Optional(
				Type.String({ description: "open | closed | all — default open." }),
			),
			limit: Type.Optional(Type.Integer({ description: "1-100, default 30." })),
		}),
		execute: async (
			_id: string,
			params: { repo_id: string; state?: string; limit?: number },
		) => {
			const r = await callHost<{ items: RepoItem[]; repo: string }>(
				"forge.list_repo_items",
				{
					repoId: params.repo_id,
					kind,
					state: params.state ?? "open",
					limit: params.limit ?? 30,
				},
			);
			const items = Array.isArray(r.items) ? r.items : [];
			const file = await scratch.write(
				`github_repo_${kind}_${safe(r.repo)}.md`,
				`# GitHub repo · ${r.repo} · ${kind}\nstate: ${params.state ?? "open"}\nfetched_at: ${now()}\ncount: ${items.length}\n\n---\n\n${renderRepoItems(items, kind === "issues" ? "issue" : "pr")}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${items.length} ${kind === "issues" ? "issue" : "PR"}(s) from ${r.repo} to scratch/${file}.`,
					},
				],
				details: { file, count: items.length, repo: r.repo },
			};
		},
	});

	const saveAttachment = {
		name: "github_save_attachment",
		label: "GitHub · Save Attachment",
		description:
			"Download an image / asset URL embedded in a GitHub issue or PR body (e.g. user-images.githubusercontent.com) into staging AND inline its bytes back to you as an image block so you can see it. Pass the returned id in propose_workspace.attachments so it's also forwarded to the downstream workspace agent.",
		parameters: Type.Object({
			url: Type.String({
				description: "Full HTTPS URL of the embedded image / asset.",
			}),
		}),
		execute: async (_id: string, params: { url: string }) => {
			const r = await callHost<{
				id: string;
				filename: string;
				sizeBytes: number;
				dataBase64?: string;
				mimeType?: string;
			}>("forge.save_attachment", {
				tickId: scratch.tickId,
				url: params.url,
			});
			return {
				content: buildAttachmentContent(
					`Saved attachment ${r.id} (${r.filename}, ${r.sizeBytes} bytes).`,
					r.dataBase64,
					r.mimeType,
				),
				details: r,
			};
		},
	};
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
		listRepoItems("issues", "github_list_repo_issues", "GitHub · Repo Issues"),
		listRepoItems("prs", "github_list_repo_prs", "GitHub · Repo PRs"),
		saveAttachment,
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
Two complementary scan modes:
- github_inbox_* — only items assigned to / mentioning / review-requested by the user. Narrow.
- github_list_repo_* — ALL open issues/PRs in a specific Helmor repo (by repo_id). Use this when the user's prompt is repo-centric ("triage helmor backlog") rather than "what's on my plate".
Drill into one item via github_view_issue / github_view_pr.`;
	},
};
