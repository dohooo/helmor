import type { PendingUserInput } from "@/features/conversation/pending-user-input";

/**
 * Generic options the frontend can attach when resolving a parked
 * `userInputRequest`. The `content` field carries whatever the matching
 * sub-renderer produced — its shape is per-kind (AUQ updatedInput, MCP
 * elicitation content map, or empty for url-mode). The sidecar's
 * resolver closure knows what to do with it.
 */
export type UserInputResponseOptions = {
	content?: Record<string, unknown>;
};

export type UserInputResponseHandler = (
	userInput: PendingUserInput,
	action: "submit" | "decline" | "cancel",
	options?: UserInputResponseOptions,
) => void;

// AskUserQuestion-specific view-model types. These are the shape the
// existing AUQ renderer reads; we keep them as-is so the panel UI is
// unchanged.

export type AskUserQuestionOption = {
	label: string;
	description: string;
	preview: string | null;
};

export type AskUserQuestionAnnotation = {
	preview?: string;
	notes?: string;
};

export type AskUserQuestionItem = {
	key: string;
	header: string;
	question: string;
	options: AskUserQuestionOption[];
	multiSelect: boolean;
};

export type AskUserQuestionViewModel = {
	kind: "ask-user-question";
	userInputId: string;
	source: string;
	questions: AskUserQuestionItem[];
	answers: Record<string, string>;
	annotations: Record<string, AskUserQuestionAnnotation>;
	rawInput: Record<string, unknown>;
};

export type UnsupportedAskUserQuestionViewModel = {
	kind: "unsupported";
	userInputId: string;
	reason: string;
};

export type AskUserQuestionPayloadViewModel =
	| AskUserQuestionViewModel
	| UnsupportedAskUserQuestionViewModel;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readBoolean(value: unknown): boolean {
	return value === true;
}

function readStringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const next: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") next[key] = entry;
	}
	return next;
}

function readAnnotations(
	value: unknown,
): Record<string, AskUserQuestionAnnotation> {
	if (!isRecord(value)) return {};
	const next: Record<string, AskUserQuestionAnnotation> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		const preview = readString(entry.preview);
		const notes = readString(entry.notes);
		if (!preview && !notes) continue;
		next[key] = {
			...(preview ? { preview } : {}),
			...(notes ? { notes } : {}),
		};
	}
	return next;
}

function normalizeQuestion(
	value: unknown,
	index: number,
): AskUserQuestionItem | null {
	if (!isRecord(value)) return null;

	const question = readString(value.question);
	if (!question) return null;

	const optionsValue = value.options;
	if (!Array.isArray(optionsValue)) return null;

	const options = optionsValue
		.map((option) => {
			if (!isRecord(option)) return null;
			const label = readString(option.label);
			if (!label) return null;
			return {
				label,
				description: readString(option.description) ?? "",
				preview: readString(option.preview),
			} satisfies AskUserQuestionOption;
		})
		.filter((option): option is AskUserQuestionOption => option !== null);

	if (options.length === 0) return null;

	return {
		key: question,
		header: readString(value.header) ?? `Question ${index + 1}`,
		question,
		options,
		multiSelect: readBoolean(value.multiSelect),
	};
}

/**
 * Build the view model the AskUserQuestion renderer expects. Returns
 * an `unsupported` shape when the payload doesn't have any well-formed
 * questions — the dispatcher renders a fallback in that case so a
 * malformed AUQ input doesn't blank the panel.
 *
 * NOTE: this builds the existing AUQ view model verbatim — preview /
 * notes / header / multiSelect / answers / annotations / `metadata.source`
 * all flow through unchanged from the AUQ tool input.
 */
export function normalizeAskUserQuestion(
	userInput: PendingUserInput,
): AskUserQuestionPayloadViewModel {
	if (userInput.payload.kind !== "ask-user-question") {
		return {
			kind: "unsupported",
			userInputId: userInput.userInputId,
			reason: "Expected ask-user-question payload.",
		};
	}

	const rawInput = {
		questions: userInput.payload.questions,
		...(userInput.payload.metadata
			? { metadata: userInput.payload.metadata }
			: {}),
	};

	const questions = userInput.payload.questions
		.map((q, index) => normalizeQuestion(q, index))
		.filter((q): q is AskUserQuestionItem => q !== null);

	if (questions.length === 0) {
		return {
			kind: "unsupported",
			userInputId: userInput.userInputId,
			reason: "AskUserQuestion payload has no well-formed questions.",
		};
	}

	const metadata = userInput.payload.metadata;
	const source =
		userInput.source || (metadata ? (readString(metadata.source) ?? "") : "");
	const answers = isRecord(rawInput.questions)
		? {}
		: readStringRecord((rawInput as { answers?: unknown }).answers);
	const annotations = readAnnotations(
		(rawInput as { annotations?: unknown }).annotations,
	);

	return {
		kind: "ask-user-question",
		userInputId: userInput.userInputId,
		source,
		questions,
		answers,
		annotations,
		rawInput,
	};
}
