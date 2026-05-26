// Layer-2 LLM tools: list_repos, propose_workspace, mark_not_actionable,
// read_candidate. Together they replace the entire old provider /
// scratch tool surface.

import { Type } from "@earendil-works/pi-ai";
import { callHost } from "../../host-bridge";
import type { TriageProposal, TriageRepo } from "../types";

export interface PropositionBudget {
	readonly max: number;
}

export class ProposalAccumulator {
	private readonly proposals: TriageProposal[] = [];
	private readonly decided: Set<string> = new Set();

	push(proposal: TriageProposal): void {
		this.proposals.push(proposal);
		this.decided.add(proposal.candidateId);
	}

	markDecided(candidateId: string): void {
		this.decided.add(candidateId);
	}

	hasDecided(candidateId: string): boolean {
		return this.decided.has(candidateId);
	}

	get count(): number {
		return this.proposals.length;
	}

	drain(): TriageProposal[] {
		const out = [...this.proposals];
		this.proposals.length = 0;
		return out;
	}
}

export function buildListReposTool(repos: readonly TriageRepo[]) {
	return {
		name: "list_repos",
		label: "List Helmor Repos",
		description:
			"List all repos the user has registered in Helmor. Use the returned id field when calling propose_workspace.",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [
				{ type: "text" as const, text: JSON.stringify(repos, null, 2) },
			],
			details: { repos },
		}),
	};
}

export function buildProposeWorkspaceTool(
	accumulator: ProposalAccumulator,
	budget: PropositionBudget,
) {
	return {
		name: "propose_workspace",
		label: "Propose AI Workspace",
		description:
			"Record ONE actionable task you found. For IM candidates (Slack/Lark) a single chat may contain multiple independent tasks — call this tool once per task with a unique `task_anchor` (the id of the message that anchors the task). For forge candidates (GitHub/GitLab issue/PR) `task_anchor` can be the issue/PR id from the candidate row.",
		parameters: Type.Object({
			candidate_id: Type.String({
				description:
					"Id of the candidate (chat / issue) from the list you were given.",
			}),
			task_anchor: Type.String({
				description:
					"Stable id of the anchor message / issue / pr that this task is about. For Lark/Slack messages, use the message id (e.g. `om_xxx`, the slack `ts`). Used for dedup AND surfaced in next tick's chat file under `last_proposed_anchors` so you don't re-propose the same task.",
			}),
			repo_id: Type.String({ description: "Helmor repo id from list_repos." }),
			title: Type.String({
				description:
					'Short human-readable label, max ~50 chars, no quotes. Use the user\'s language. Becomes the session title in the sidebar — make it scannable (e.g. "修复 9B 模型加载视觉编码器崩溃").',
			}),
			branch_name: Type.String({
				description:
					"Lowercase-hyphen English slug for the git branch, max ~40 chars. No prefix (Helmor adds your username/). Examples: `fix-vision-loader-crash`, `triage-feedback-button`.",
			}),
			plan_message: Type.String({
				description:
					"Markdown plan shown verbatim as first assistant message in the new workspace.",
			}),
		}),
		execute: async (
			_id: string,
			params: {
				candidate_id: string;
				task_anchor: string;
				repo_id: string;
				title: string;
				branch_name: string;
				plan_message: string;
			},
		) => {
			const anchorKey = `${params.candidate_id}::${params.task_anchor}`;
			if (accumulator.hasDecided(anchorKey)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Skipped: ${anchorKey} was already proposed this tick.`,
						},
					],
					details: { skipped: true, reason: "already_decided" },
				};
			}
			if (accumulator.count >= budget.max) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Skipped: reached cap of ${budget.max} proposals this run.`,
						},
					],
					details: { skipped: true, reason: "cap_reached" },
				};
			}
			accumulator.push({
				candidateId: params.candidate_id,
				taskAnchor: params.task_anchor,
				repoId: params.repo_id,
				title: params.title,
				branchName: params.branch_name,
				planMessage: params.plan_message,
			});
			// Track per-anchor so multiple tasks from the same chat each
			// count once and don't trigger the "already decided" branch.
			accumulator.markDecided(anchorKey);
			return {
				content: [
					{
						type: "text" as const,
						text: `Recorded proposal "${params.title}" for ${anchorKey}.`,
					},
				],
				details: { skipped: false },
			};
		},
	};
}

export function buildMarkNotActionableTool(accumulator: ProposalAccumulator) {
	return {
		name: "mark_not_actionable",
		label: "Mark Candidate Skipped",
		description:
			"Mark this candidate (entire chat / issue) as having nothing actionable RIGHT NOW. For IM chats this means: you read the recent messages and there's no task buried in there. The decision is NOT terminal for chats — if new messages arrive in this chat later, Helmor will surface it again. So this is safe to use liberally.",
		parameters: Type.Object({
			candidate_id: Type.String({
				description: "Id of the candidate.",
			}),
			reason: Type.String({
				description:
					"One short sentence on why. Goes into the candidate row and shows in the inspector.",
			}),
		}),
		execute: async (
			_id: string,
			params: { candidate_id: string; reason: string },
		) => {
			if (accumulator.hasDecided(params.candidate_id)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Already decided ${params.candidate_id} earlier this tick.`,
						},
					],
					details: { skipped: true },
				};
			}
			await callHost<{ ok: boolean }>("triage.record_decision", {
				candidateId: params.candidate_id,
				decision: "skip",
				reason: params.reason,
			});
			accumulator.markDecided(params.candidate_id);
			return {
				content: [
					{
						type: "text" as const,
						text: `Marked ${params.candidate_id} not actionable.`,
					},
				],
				details: { reason: params.reason },
			};
		},
	};
}

/// `read_candidate` — read the chat/issue markdown file.
///   - default: whole file truncated at 8 KB
///   - `grep`: substring filter ±3 lines context
///   - `tail`: last N lines (useful for chat files when you want the
///             most recent activity even if the file is >8KB)
export function buildReadCandidateTool() {
	return {
		name: "read_candidate",
		label: "Read Candidate Payload",
		description:
			"Read the full Markdown body of one candidate (chat or issue). Defaults: whole file, truncated at 8 KB. For long chat windows, prefer `tail=<N>` (last N messages) over the default truncation. For huge issue/PR bodies, use `grep=<pattern>` to filter to matching lines + 3 lines context. `grep` and `tail` are mutually exclusive; pass at most one.",
		parameters: Type.Object({
			candidate_id: Type.String({
				description: "Id of the candidate.",
			}),
			grep: Type.Optional(
				Type.String({
					description:
						"Optional case-insensitive substring filter. Returns matching lines + 3 lines of context, joined by `---`.",
				}),
			),
			tail: Type.Optional(
				Type.Integer({
					description:
						"Optional. Return the last N message blocks (`## ...`-delimited sections). Useful on chat candidates — gives you the freshest activity instead of the truncated head. 1-200.",
				}),
			),
		}),
		execute: async (
			_id: string,
			params: { candidate_id: string; grep?: string; tail?: number },
		) => {
			const r = await callHost<{ body: string }>("triage.read_candidate", {
				candidateId: params.candidate_id,
				grep: params.grep,
				tail: params.tail,
			});
			return {
				content: [{ type: "text" as const, text: r.body }],
				details: { bytes: r.body.length },
			};
		},
	};
}
