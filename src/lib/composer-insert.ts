import type {
	ContextCardSource,
	ContextCardStateTone,
} from "@/lib/sources/types";

export type ComposerPreviewPayload =
	| {
			kind: "image";
			title: string;
			path: string;
	  }
	| {
			kind: "text";
			title: string;
			text: string;
	  }
	| {
			kind: "code";
			title: string;
			code: string;
			language?: string;
	  };

export const COMPOSER_PREVIEW_BADGE_THRESHOLD = 500;
const COMPOSER_PREVIEW_LABEL_MAX_CHARS = 40;

/** The size gate for "this paste is bulk, not prose" — at or above it the
 *  composer turns the paste into a tag badge. */
export function exceedsComposerPreviewBadgeThreshold(content: string): boolean {
	return content.trim().length >= COMPOSER_PREVIEW_BADGE_THRESHOLD;
}

/**
 * Locate each pasted tag's `submitText` inside the final composed prompt,
 * returning UTF-16 ranges (in tag document order) for the send request's
 * `pastedTexts`. The composer's extraction normalizes the joined text
 * (3+ newlines collapse, edge trim), so each needle gets the same newline
 * normalization, with an edge-trimmed retry for tags sitting at the prompt
 * boundary. A tag that still can't be found is skipped — that span simply
 * renders as plain text instead of a chip.
 */
export function locatePastedTextRanges(
	prompt: string,
	customTags: readonly ComposerCustomTag[],
): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	let searchFrom = 0;
	for (const tag of customTags) {
		const normalized = tag.submitText.replace(/\n{3,}/g, "\n\n");
		let needle = normalized;
		let index = prompt.indexOf(needle, searchFrom);
		if (index === -1) {
			needle = normalized.trim();
			if (!needle) continue;
			index = prompt.indexOf(needle, searchFrom);
		}
		if (index === -1) continue;
		ranges.push({ start: index, end: index + needle.length });
		searchFrom = index + needle.length;
	}
	return ranges;
}

export type ComposerCustomTag = {
	id: string;
	label: string;
	submitText: string;
	preview?: ComposerPreviewPayload | null;
	source?: ContextCardSource;
	stateTone?: ContextCardStateTone;
};

export type ComposerInsertItem =
	| { kind: "text"; text: string }
	| { kind: "file"; path: string }
	| { kind: "image"; path: string }
	| {
			kind: "custom-tag";
			label: string;
			submitText: string;
			key?: string;
			preview?: ComposerPreviewPayload | null;
			source?: ContextCardSource;
			stateTone?: ContextCardStateTone;
	  };

function truncateComposerPreviewLabel(label: string): string {
	if (label.length <= COMPOSER_PREVIEW_LABEL_MAX_CHARS) {
		return label;
	}

	return `${label.slice(0, COMPOSER_PREVIEW_LABEL_MAX_CHARS - 1)}…`;
}

export function buildComposerPreviewLabel(
	content: string,
	kind: ComposerPreviewPayload["kind"],
): string {
	const candidate = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith("```"));

	if (!candidate) {
		return kind === "code" ? "Pasted code" : "Pasted text";
	}

	return truncateComposerPreviewLabel(candidate);
}

export type ComposerInsertTarget = {
	contextKey?: string | null;
	workspaceId?: string | null;
	sessionId?: string | null;
};

export type ComposerInsertRequest = {
	target?: ComposerInsertTarget;
	items: ComposerInsertItem[];
	behavior?: "append";
};

export type ResolvedComposerInsertRequest = {
	id: string;
	contextKey?: string | null;
	workspaceId: string | null;
	sessionId: string | null;
	items: ComposerInsertItem[];
	behavior: "append";
	createdAt: number;
};

export function inferComposerPreviewLanguage(
	input: string,
): string | undefined {
	const fencedMatch = input.match(/```([a-z0-9#+.-]+)/i);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].toLowerCase();
	}

	const trimmed = input.trim();
	if (/^[{[]/.test(trimmed)) return "json";
	if (/^diff --git/m.test(input) || /^@@/m.test(input)) return "diff";
	if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/im.test(input)) return "sql";
	if (
		/^\s*(const|let|var|function|import|export|class|interface|type)\b/m.test(
			input,
		)
	) {
		return "ts";
	}
	if (/^\s*<(!DOCTYPE|html|[A-Za-z][^>]*)/m.test(trimmed)) return "html";
	if (/^\s*(name:|uses:|on:|jobs:)\s/m.test(input)) return "yaml";
	return undefined;
}

export function buildComposerPreviewPayload({
	title,
	content,
	preferredKind = "auto",
}: {
	title: string;
	content: string;
	preferredKind?: "auto" | "text" | "code";
}): ComposerPreviewPayload | null {
	if (!exceedsComposerPreviewBadgeThreshold(content)) {
		return null;
	}

	if (preferredKind === "text") {
		return {
			kind: "text",
			title,
			text: content,
		};
	}

	const language = inferComposerPreviewLanguage(content);
	if (preferredKind === "code" || language) {
		return {
			kind: "code",
			title,
			code: content,
			...(language ? { language } : {}),
		};
	}

	return {
		kind: "text",
		title,
		text: content,
	};
}

export function buildComposerPreviewInsertItem({
	content,
	label,
	key,
	preferredKind = "auto",
}: {
	content: string;
	label?: string;
	key?: string;
	preferredKind?: "auto" | "text" | "code";
}): Extract<ComposerInsertItem, { kind: "custom-tag" }> | null {
	const preview = buildComposerPreviewPayload({
		title: label ?? "",
		content,
		preferredKind,
	});
	if (!preview) {
		return null;
	}

	const resolvedLabel =
		label ?? buildComposerPreviewLabel(content, preview.kind);

	return {
		kind: "custom-tag",
		label: resolvedLabel,
		submitText: content,
		...(key ? { key } : {}),
		preview: {
			...preview,
			title: resolvedLabel,
		},
	};
}

export function resolveComposerInsertTarget(
	requestTarget: ComposerInsertTarget | undefined,
	currentTarget: {
		selectedWorkspaceId: string | null;
		displayedWorkspaceId: string | null;
		displayedSessionId: string | null;
	},
): ComposerInsertTarget {
	return {
		contextKey: requestTarget?.contextKey,
		workspaceId:
			requestTarget?.workspaceId ??
			currentTarget.displayedWorkspaceId ??
			currentTarget.selectedWorkspaceId,
		sessionId:
			requestTarget?.sessionId === undefined
				? currentTarget.displayedSessionId
				: requestTarget.sessionId,
	};
}

export function insertRequestMatchesComposer(
	request: ResolvedComposerInsertRequest,
	target: {
		contextKey?: string | null;
		workspaceId: string | null;
		sessionId: string | null;
	},
): boolean {
	if (request.contextKey) {
		return request.contextKey === target.contextKey;
	}

	if (!target.workspaceId || request.workspaceId !== target.workspaceId) {
		return false;
	}

	if (request.sessionId === null) {
		return target.sessionId === null || typeof target.sessionId === "string";
	}

	return request.sessionId === target.sessionId;
}
