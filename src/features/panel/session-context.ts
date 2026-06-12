import type { AgentProvider, WorkspaceSessionSummary } from "@/lib/api";

const MAX_CONTEXT_SESSION_CANDIDATES = 20;

export type SessionContextCandidate = Pick<
	WorkspaceSessionSummary,
	| "id"
	| "workspaceId"
	| "title"
	| "agentType"
	| "status"
	| "createdAt"
	| "updatedAt"
	| "lastUserMessageAt"
> & {
	displayProvider: AgentProvider | null;
};

function sessionRecency(
	session: Pick<
		WorkspaceSessionSummary,
		"lastUserMessageAt" | "updatedAt" | "createdAt"
	>,
): number {
	return Date.parse(
		session.lastUserMessageAt ?? session.updatedAt ?? session.createdAt,
	);
}

export function buildSessionContextCandidates({
	sessions,
	currentSessionId,
	displayProviderBySessionId = {},
}: {
	sessions: readonly WorkspaceSessionSummary[];
	currentSessionId: string | null;
	displayProviderBySessionId?: Partial<Record<string, AgentProvider | null>>;
}): SessionContextCandidate[] {
	return sessions
		.filter((session) => session.id !== currentSessionId)
		.filter((session) => !session.isHidden)
		.filter((session) => session.sessionKind !== "terminal")
		.filter((session) => Boolean(session.lastUserMessageAt))
		.sort((a, b) => sessionRecency(b) - sessionRecency(a))
		.slice(0, MAX_CONTEXT_SESSION_CANDIDATES)
		.map((session) => ({
			id: session.id,
			workspaceId: session.workspaceId,
			title: session.title,
			agentType: session.agentType,
			status: session.status,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			lastUserMessageAt: session.lastUserMessageAt,
			displayProvider: displayProviderBySessionId[session.id] ?? null,
		}));
}
