// Helmor-internal tools: list_repos + propose_workspace accumulator.

import { Type } from "@earendil-works/pi-ai";
import type { TriageProposal, TriageRepo } from "../types";

export interface PropositionBudget {
	readonly max: number;
}

export class ProposalAccumulator {
	private readonly proposals: TriageProposal[] = [];

	push(proposal: TriageProposal): { skipped: boolean } {
		this.proposals.push(proposal);
		return { skipped: false };
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
			"Record one actionable task. Helmor creates a workspace from the matched repo and pre-fills plan_message as the first assistant message. Call once per task. Do NOT analyse implementation here.",
		parameters: Type.Object({
			source_type: Type.String({
				description:
					"Stable source category (e.g. lark, gitlab_issue, github_issue).",
			}),
			source_ref: Type.String({ description: "Stable id within the source." }),
			repo_id: Type.String({ description: "Helmor repo id from list_repos." }),
			plan_message: Type.String({
				description:
					"Markdown plan shown verbatim as first assistant message in the new workspace.",
			}),
		}),
		execute: async (
			_id: string,
			params: {
				source_type: string;
				source_ref: string;
				repo_id: string;
				plan_message: string;
			},
		) => {
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
				sourceType: params.source_type,
				sourceRef: params.source_ref,
				repoId: params.repo_id,
				planMessage: params.plan_message,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Recorded proposal for ${params.source_type}/${params.source_ref}.`,
					},
				],
				details: { skipped: false },
			};
		},
	};
}
