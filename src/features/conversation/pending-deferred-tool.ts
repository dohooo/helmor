import type { AgentProvider, AgentStreamEvent } from "@/lib/api";

export type PendingDeferredTool = {
	provider: AgentProvider;
	modelId: string;
	resolvedModel: string;
	providerSessionId?: string | null;
	workingDirectory: string;
	permissionMode?: string | null;
	toolUseId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
};

type DeferredToolUseEvent = Extract<
	AgentStreamEvent,
	{ kind: "deferredToolUse" }
>;

export function buildPendingDeferredTool(
	event: DeferredToolUseEvent,
	fallbackModelId?: string | null,
): PendingDeferredTool | null {
	const modelId = event.modelId || fallbackModelId || null;
	if (!modelId) {
		return null;
	}

	return {
		provider: event.provider,
		modelId,
		resolvedModel: event.resolvedModel,
		providerSessionId: event.sessionId,
		workingDirectory: event.workingDirectory,
		permissionMode: event.permissionMode,
		toolUseId: event.toolUseId,
		toolName: event.toolName,
		toolInput: event.toolInput,
	};
}

export function getDeferredToolResumeModelId(
	deferred: PendingDeferredTool,
	fallbackModelId?: string | null,
): string | null {
	return deferred.modelId || fallbackModelId || null;
}
