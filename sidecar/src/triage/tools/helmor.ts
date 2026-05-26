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
			"Record one actionable task for the candidate. Helmor creates a workspace from the matched repo, names the session with `title`, names the git branch with `branch_name`, and pre-fills `plan_message` as the first assistant message. Call once per actionable candidate. Do NOT analyse implementation here.",
		parameters: Type.Object({
			candidate_id: Type.String({
				description:
					"Id of the candidate (from the list you were given). Helmor uses it to mark the candidate decided AND to dedup against existing triage workspaces.",
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
				repo_id: string;
				title: string;
				branch_name: string;
				plan_message: string;
			},
		) => {
			if (accumulator.hasDecided(params.candidate_id)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Skipped: candidate ${params.candidate_id} was already decided this tick.`,
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
				repoId: params.repo_id,
				title: params.title,
				branchName: params.branch_name,
				planMessage: params.plan_message,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Recorded proposal "${params.title}" for candidate ${params.candidate_id}.`,
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
			"Record that this candidate is NOT actionable (chat noise, status update, already handled, etc.). Helmor stores the decision so the candidate never appears in a future tick.",
		parameters: Type.Object({
			candidate_id: Type.String({
				description: "Id of the candidate to dismiss.",
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

/**
 * Optional drill-tool: list other OPEN candidates in the same source-
 * parent (chat / repo) as a candidate you're looking at. Use this when
 * the preview is ambiguous and you want to see if the same person /
 * channel has related context you haven't seen yet.
 *
 * Doesn't open files — returns metadata + preview rows, exactly the
 * same shape the main prompt already gave you. Cheap.
 */
export function buildListCandidatesInParentTool() {
	return {
		name: "list_candidates_in_parent",
		label: "List Sibling Candidates",
		description:
			"List other OPEN (un-decided) candidates that share the same chat / repo as `parent`. Returns metadata + 400-char preview per row, same shape as the candidate list you were given. Use sparingly — only when an ambiguous preview hints at related context elsewhere.",
		parameters: Type.Object({
			parent: Type.String({
				description:
					"`sourceParent` value from a candidate (chat_id / channel_id / 'owner/repo').",
			}),
			exclude_id: Type.Optional(
				Type.String({
					description:
						"Candidate id to exclude from results (usually the one you're currently looking at).",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					description: "1-100, default 20.",
				}),
			),
		}),
		execute: async (
			_id: string,
			params: { parent: string; exclude_id?: string; limit?: number },
		) => {
			const rows = await callHost<unknown[]>(
				"triage.list_candidates_in_parent",
				{
					parent: params.parent,
					excludeId: params.exclude_id,
					limit: params.limit,
				},
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(rows, null, 2) },
				],
				details: { count: rows.length },
			};
		},
	};
}

export function buildReadCandidateTool() {
	return {
		name: "read_candidate",
		label: "Read Candidate Payload",
		description:
			"Read the full Markdown body of one candidate. Default returns the whole file (truncated at 8 KB). Pass `grep=<pattern>` to filter to lines matching a substring (case-insensitive) with ±3 lines of context — use this for very long PR bodies / chat threads instead of reading the whole file.",
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
		}),
		execute: async (
			_id: string,
			params: { candidate_id: string; grep?: string },
		) => {
			const r = await callHost<{ body: string }>("triage.read_candidate", {
				candidateId: params.candidate_id,
				grep: params.grep,
			});
			return {
				content: [{ type: "text" as const, text: r.body }],
				details: { bytes: r.body.length },
			};
		},
	};
}
