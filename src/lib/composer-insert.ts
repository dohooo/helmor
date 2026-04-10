export type ComposerCustomTag = {
	id: string;
	label: string;
	submitText: string;
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
	  };

export type ComposerInsertTarget = {
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
	workspaceId: string;
	sessionId: string | null;
	items: ComposerInsertItem[];
	behavior: "append";
	createdAt: number;
};

export function resolveComposerInsertTarget(
	requestTarget: ComposerInsertTarget | undefined,
	currentTarget: {
		selectedWorkspaceId: string | null;
		displayedWorkspaceId: string | null;
		displayedSessionId: string | null;
	},
): ComposerInsertTarget {
	return {
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
	target: { workspaceId: string | null; sessionId: string | null },
): boolean {
	if (!target.workspaceId || request.workspaceId !== target.workspaceId) {
		return false;
	}

	if (request.sessionId === null) {
		return target.sessionId === null || typeof target.sessionId === "string";
	}

	return request.sessionId === target.sessionId;
}
