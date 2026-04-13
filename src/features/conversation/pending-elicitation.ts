import type { AgentStreamEvent } from "@/lib/api";

export type PendingElicitation = {
	provider: "claude" | "codex";
	modelId: string;
	resolvedModel: string;
	providerSessionId?: string | null;
	workingDirectory: string;
	elicitationId: string;
	serverName: string;
	message: string;
	mode: "form" | "url";
	url?: string | null;
	requestedSchema?: Record<string, unknown> | null;
};

type ElicitationRequestEvent = Extract<
	AgentStreamEvent,
	{ kind: "elicitationRequest" }
>;

export function buildPendingElicitation(
	event: ElicitationRequestEvent,
	fallbackModelId?: string | null,
): PendingElicitation | null {
	const elicitationId = event.elicitationId?.trim();
	const modelId = event.modelId || fallbackModelId || null;
	if (!elicitationId || !modelId) {
		return null;
	}

	return {
		provider: event.provider,
		modelId,
		resolvedModel: event.resolvedModel,
		providerSessionId: event.sessionId,
		workingDirectory: event.workingDirectory,
		elicitationId,
		serverName: event.serverName,
		message: event.message,
		mode: event.mode === "url" ? "url" : "form",
		url: event.url,
		requestedSchema: event.requestedSchema,
	};
}
