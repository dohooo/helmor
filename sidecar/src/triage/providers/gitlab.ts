// GitLab provider — thin wrapper over the Rust `forge.*` host bridge.

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

interface RepoItemGitlab {
	iid?: number;
	title?: string;
	state?: string;
	author?: { username?: string } | null;
	assignees?: Array<{ username?: string } | string | null>;
	labels?: Array<string | { name?: string }>;
	web_url?: string;
	updated_at?: string;
	description?: string;
	draft?: boolean;
	work_in_progress?: boolean;
}

function renderRepoItemsGitlab(
	items: RepoItemGitlab[],
	kind: "issue" | "mr",
): string {
	const out: string[] = [];
	const sigil = kind === "issue" ? "#" : "!";
	for (const it of items) {
		out.push(`## ${sigil}${it.iid ?? "?"} — ${it.title ?? "(no title)"}`);
		if (it.state) out.push(`- state: ${it.state}`);
		if (it.draft || it.work_in_progress) out.push(`- draft: true`);
		if (it.author?.username) out.push(`- author: ${it.author.username}`);
		const assignees = (it.assignees ?? [])
			.map((a) => (typeof a === "string" ? a : a?.username))
			.filter((s): s is string => !!s);
		if (assignees.length > 0) out.push(`- assignees: ${assignees.join(", ")}`);
		const labels = (it.labels ?? [])
			.map((l) => (typeof l === "string" ? l : l?.name))
			.filter((s): s is string => !!s);
		if (labels.length > 0) out.push(`- labels: ${labels.join(", ")}`);
		if (it.updated_at) out.push(`- updated: ${it.updated_at}`);
		if (it.web_url) out.push(`- url: ${it.web_url}`);
		if (it.description?.trim())
			out.push("", "```", it.description.trim(), "```");
		out.push("", "---", "");
	}
	return out.join("\n");
}

function buildTools({ scratch }: ProviderContext): unknown[] {
	const listRepoItems = (
		kind: "issues" | "mrs",
		toolName: string,
		label: string,
	) => ({
		name: toolName,
		label,
		description:
			kind === "issues"
				? "List ALL open issues in a Helmor GitLab repo (not just yours). Use for repo-centric triage."
				: "List ALL open MRs in a Helmor GitLab repo (not just yours / not just review-requested).",
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
			const r = await callHost<{ items: RepoItemGitlab[]; repo: string }>(
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
				`gitlab_repo_${kind}_${safe(r.repo)}.md`,
				`# GitLab repo · ${r.repo} · ${kind}\nstate: ${params.state ?? "open"}\nfetched_at: ${now()}\ncount: ${items.length}\n\n---\n\n${renderRepoItemsGitlab(items, kind === "issues" ? "issue" : "mr")}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${items.length} ${kind === "issues" ? "issue" : "MR"}(s) from ${r.repo} to scratch/${file}.`,
					},
				],
				details: { file, count: items.length, repo: r.repo },
			};
		},
	});

	const saveAttachment = {
		name: "gitlab_save_attachment",
		label: "GitLab · Save Attachment",
		description:
			"Download an image / asset URL embedded in a GitLab issue or MR body into staging AND inline its bytes back to you as an image block so you can see it. Pass the returned id in propose_workspace.attachments so it's also forwarded to the downstream workspace agent.",
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
		listRepoItems("issues", "gitlab_list_repo_issues", "GitLab · Repo Issues"),
		listRepoItems("mrs", "gitlab_list_repo_mrs", "GitLab · Repo MRs"),
		saveAttachment,
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
Two complementary scan modes:
- gitlab_inbox_* — only items assigned to / mentioning the user. Narrow.
- gitlab_list_repo_* — ALL open issues/MRs in a Helmor repo (by repo_id). Use for repo-centric triage ("scan hdcode backlog").
Drill into one item via gitlab_view_issue / gitlab_view_mr.`;
	},
};
