import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";

export type DeferredToolResponseOptions = {
	reason?: string;
	updatedInput?: Record<string, unknown>;
};

export type DeferredToolResponseHandler = (
	deferred: PendingDeferredTool,
	behavior: "allow" | "deny",
	options?: DeferredToolResponseOptions,
) => void;

export type DeferredQuestionOption = {
	label: string;
	description: string;
	preview: string | null;
};

export type DeferredQuestionAnnotation = {
	preview?: string;
	notes?: string;
};

export type DeferredQuestion = {
	key: string;
	header: string;
	question: string;
	options: DeferredQuestionOption[];
	multiSelect: boolean;
};

export type AskUserQuestionViewModel = {
	kind: "ask-user-question";
	toolUseId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	questions: DeferredQuestion[];
	answers: Record<string, string>;
	annotations: Record<string, DeferredQuestionAnnotation>;
	source: string | null;
};

export type GenericDeferredToolViewModel = {
	kind: "generic";
	toolUseId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
};

export type DeferredToolViewModel =
	| AskUserQuestionViewModel
	| GenericDeferredToolViewModel;

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
	if (!isRecord(value)) {
		return {};
	}

	const next: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			next[key] = entry;
		}
	}

	return next;
}

function readAnnotations(
	value: unknown,
): Record<string, DeferredQuestionAnnotation> {
	if (!isRecord(value)) {
		return {};
	}

	const next: Record<string, DeferredQuestionAnnotation> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isRecord(entry)) {
			continue;
		}

		const preview = readString(entry.preview);
		const notes = readString(entry.notes);
		if (!preview && !notes) {
			continue;
		}

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
): DeferredQuestion | null {
	if (!isRecord(value)) {
		return null;
	}

	const question = readString(value.question);
	if (!question) {
		return null;
	}

	const optionsValue = value.options;
	if (!Array.isArray(optionsValue)) {
		return null;
	}

	const options = optionsValue
		.map((option) => {
			if (!isRecord(option)) {
				return null;
			}

			const label = readString(option.label);
			if (!label) {
				return null;
			}

			return {
				label,
				description: readString(option.description) ?? "",
				preview: readString(option.preview),
			} satisfies DeferredQuestionOption;
		})
		.filter((option): option is DeferredQuestionOption => option !== null);

	if (options.length === 0) {
		return null;
	}

	return {
		key: question,
		header: readString(value.header) ?? `Question ${index + 1}`,
		question,
		options,
		multiSelect: readBoolean(value.multiSelect),
	};
}

function normalizeAskUserQuestion(
	deferred: PendingDeferredTool,
): AskUserQuestionViewModel | null {
	if (deferred.toolName !== "AskUserQuestion") {
		return null;
	}

	const questionsValue = deferred.toolInput.questions;
	if (!Array.isArray(questionsValue)) {
		return null;
	}

	const questions = questionsValue
		.map((question, index) => normalizeQuestion(question, index))
		.filter((question): question is DeferredQuestion => question !== null);

	if (questions.length === 0) {
		return null;
	}

	const metadata = isRecord(deferred.toolInput.metadata)
		? deferred.toolInput.metadata
		: null;

	return {
		kind: "ask-user-question",
		toolUseId: deferred.toolUseId,
		toolName: deferred.toolName,
		toolInput: deferred.toolInput,
		questions,
		answers: readStringRecord(deferred.toolInput.answers),
		annotations: readAnnotations(deferred.toolInput.annotations),
		source: metadata ? readString(metadata.source) : null,
	};
}

export function normalizeDeferredTool(
	deferred: PendingDeferredTool,
): DeferredToolViewModel {
	const askUserQuestion = normalizeAskUserQuestion(deferred);
	if (askUserQuestion) {
		return askUserQuestion;
	}

	return {
		kind: "generic",
		toolUseId: deferred.toolUseId,
		toolName: deferred.toolName,
		toolInput: deferred.toolInput,
	};
}
