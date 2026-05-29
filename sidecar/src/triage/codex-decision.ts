import type { TriageProposal } from "./types";

export type CodexTriageDecision = {
	readonly proposals: TriageProposal[];
	readonly skips: readonly { candidateId: string; reason: string }[];
	readonly summary: string | null;
};

export function parseCodexDecision(text: string): CodexTriageDecision {
	const jsonText = extractJsonObject(text);
	const parsed = JSON.parse(jsonText) as Record<string, unknown>;
	const proposals = Array.isArray(parsed.proposals)
		? parsed.proposals
				.map(coerceProposal)
				.filter((p): p is TriageProposal => p !== null)
		: [];
	const skips = Array.isArray(parsed.skips)
		? parsed.skips
				.map(coerceSkip)
				.filter((s): s is { candidateId: string; reason: string } => s !== null)
		: [];
	const summary =
		typeof parsed.summary === "string" && parsed.summary.trim().length > 0
			? parsed.summary.trim()
			: null;
	return { proposals, skips, summary };
}

function extractJsonObject(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const source = fenced?.[1] ?? text;
	const start = source.indexOf("{");
	const end = source.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("Codex triage response did not contain JSON");
	}
	return source.slice(start, end + 1);
}

function coerceProposal(value: unknown): TriageProposal | null {
	if (!value || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	const candidateId = stringField(obj, "candidateId");
	const taskAnchor = stringField(obj, "taskAnchor");
	const repoId = stringField(obj, "repoId");
	const title = stringField(obj, "title");
	const branchName = stringField(obj, "branchName");
	const planMessage = stringField(obj, "planMessage");
	if (
		!candidateId ||
		!taskAnchor ||
		!repoId ||
		!title ||
		!branchName ||
		!planMessage
	) {
		return null;
	}
	return { candidateId, taskAnchor, repoId, title, branchName, planMessage };
}

function coerceSkip(
	value: unknown,
): { candidateId: string; reason: string } | null {
	if (!value || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	const candidateId = stringField(obj, "candidateId");
	const reason = stringField(obj, "reason");
	if (!candidateId || !reason) return null;
	return { candidateId, reason };
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
	const value = obj[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
