import type { AgentProvider, AgentStreamEvent } from "@/lib/api";

/**
 * Provider/source-agnostic record for a parked unified `userInputRequest`.
 *
 * The `payload` discriminator selects how the frontend renders:
 * `ask-user-question` keeps Claude AskUserQuestion's native multi-question /
 * options / preview / notes / always-other UI; `form` is a JSON-Schema
 * driven form panel (used for both Claude MCP form elicitations and
 * Codex's synthesized form schemas); `url` is a URL-launcher card.
 *
 * The streaming context (provider, modelId, etc.) is preserved at the
 * top level so anything that needs to attribute the request to a
 * specific session can read it without unwrapping the payload.
 */
export type PendingUserInput = {
	provider: AgentProvider;
	modelId: string;
	resolvedModel: string;
	providerSessionId?: string | null;
	workingDirectory: string;
	permissionMode?: string | null;
	userInputId: string;
	source: string;
	message: string;
	payload: PendingUserInputPayload;
};

export type PendingUserInputPayload =
	| {
			kind: "ask-user-question";
			questions: Array<Record<string, unknown>>;
			metadata?: Record<string, unknown>;
	  }
	| {
			kind: "form";
			schema: Record<string, unknown>;
	  }
	| {
			kind: "url";
			url: string;
	  };

type UserInputRequestEvent = Extract<
	AgentStreamEvent,
	{ kind: "userInputRequest" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function normalizePayload(
	raw: Record<string, unknown> | undefined,
): PendingUserInputPayload | null {
	if (!raw) return null;
	const kind = raw.kind;

	if (kind === "ask-user-question") {
		const questions = Array.isArray(raw.questions)
			? raw.questions.filter((q): q is Record<string, unknown> => isRecord(q))
			: [];
		return {
			kind,
			questions,
			...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
		};
	}

	if (kind === "form") {
		const schema = isRecord(raw.schema) ? raw.schema : null;
		if (!schema) return null;
		return { kind, schema };
	}

	if (kind === "url") {
		const url = readString(raw.url).trim();
		if (!url) return null;
		return { kind, url };
	}

	return null;
}

export function buildPendingUserInput(
	event: UserInputRequestEvent,
	fallbackModelId?: string | null,
): PendingUserInput | null {
	const userInputId = event.userInputId?.trim();
	const modelId = event.modelId || fallbackModelId || null;
	if (!userInputId || !modelId) {
		return null;
	}

	const payload = normalizePayload(
		event.payload as Record<string, unknown> | undefined,
	);
	if (!payload) {
		return null;
	}

	return {
		provider: event.provider,
		modelId,
		resolvedModel: event.resolvedModel,
		providerSessionId: event.sessionId,
		workingDirectory: event.workingDirectory,
		permissionMode: event.permissionMode,
		userInputId,
		source: event.source,
		message: event.message,
		payload,
	};
}
