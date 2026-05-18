import { useReducer } from "react";

import type { ExistingHelmorWorkspace } from "@/lib/api";

/**
 * Feedback dialog is a small state machine. We model it as a tagged union so
 * it's impossible for UI components to read fields that don't apply to the
 * current step (e.g. the clone step can't accidentally read an issue URL).
 */
export type FeedbackStep =
	| { kind: "input"; input: string; error: string | null }
	| { kind: "issue-sending"; input: string }
	| { kind: "issue-done"; issueUrl: string; issueNumber: number }
	| {
			kind: "clone";
			input: string;
			// Sub-status inside the clone step; the step component drives these
			// transitions as it calls `fork` → open folder picker → `clone`.
			phase: "idle" | "forking" | "picking" | "cloning";
			forkedCloneUrl: string | null;
			cloneDirectory: string | null;
			error: string | null;
	  }
	| {
			kind: "prompt";
			input: string;
			draftPrompt: string;
			// `existing` is set on the second-and-later Quick fix — the prompt
			// step shows a hint that we'll reuse the existing repo.
			existing: ExistingHelmorWorkspace | null;
			// Repo id allocated during the clone step (or inherited from the
			// existing workspace); used by the handoff step to prepare a new
			// workspace from it.
			repoId: string | null;
	  }
	| {
			kind: "handoff";
			input: string;
			draftPrompt: string;
			repoId: string;
			error: string | null;
	  }
	| {
			kind: "pr-hint";
			workspaceId: string;
			sessionId: string;
	  };

export type FeedbackState = {
	step: FeedbackStep;
	/** Most recent detection of an existing local helmor workspace. */
	existing: ExistingHelmorWorkspace | null;
};

export type FeedbackAction =
	| { type: "set-input"; input: string }
	| { type: "set-existing"; existing: ExistingHelmorWorkspace | null }
	| { type: "start-create-issue" }
	| { type: "issue-failed"; message: string }
	| { type: "issue-succeeded"; url: string; number: number }
	| { type: "start-quick-fix" }
	| { type: "clone-phase"; phase: "forking" | "picking" | "cloning" | "idle" }
	| { type: "clone-fork-succeeded"; cloneUrl: string }
	| { type: "clone-directory-selected"; directory: string }
	| { type: "clone-failed"; message: string }
	| { type: "clone-succeeded"; repoId: string }
	| { type: "edit-prompt"; prompt: string }
	| { type: "start-handoff" }
	| { type: "handoff-failed"; message: string }
	| {
			type: "handoff-succeeded";
			workspaceId: string;
			sessionId: string;
	  }
	| { type: "reset" };

export const initialFeedbackState: FeedbackState = {
	step: { kind: "input", input: "", error: null },
	existing: null,
};

function reducer(state: FeedbackState, action: FeedbackAction): FeedbackState {
	switch (action.type) {
		case "set-input": {
			if (state.step.kind !== "input") return state;
			return {
				...state,
				step: { ...state.step, input: action.input, error: null },
			};
		}
		case "set-existing": {
			return { ...state, existing: action.existing };
		}
		case "start-create-issue": {
			if (state.step.kind !== "input") return state;
			return {
				...state,
				step: { kind: "issue-sending", input: state.step.input },
			};
		}
		case "issue-failed": {
			if (state.step.kind !== "issue-sending") return state;
			return {
				...state,
				step: {
					kind: "input",
					input: state.step.input,
					error: action.message,
				},
			};
		}
		case "issue-succeeded": {
			return {
				...state,
				step: {
					kind: "issue-done",
					issueUrl: action.url,
					issueNumber: action.number,
				},
			};
		}
		case "start-quick-fix": {
			if (state.step.kind !== "input") return state;
			if (state.existing) {
				// Skip fork + clone entirely; open the prompt step on the
				// existing repo.
				return {
					...state,
					step: {
						kind: "prompt",
						input: state.step.input,
						draftPrompt: "",
						existing: state.existing,
						repoId: state.existing.repoId,
					},
				};
			}
			return {
				...state,
				step: {
					kind: "clone",
					input: state.step.input,
					phase: "forking",
					forkedCloneUrl: null,
					cloneDirectory: null,
					error: null,
				},
			};
		}
		case "clone-phase": {
			if (state.step.kind !== "clone") return state;
			return {
				...state,
				step: { ...state.step, phase: action.phase, error: null },
			};
		}
		case "clone-fork-succeeded": {
			if (state.step.kind !== "clone") return state;
			return {
				...state,
				step: {
					...state.step,
					phase: "picking",
					forkedCloneUrl: action.cloneUrl,
					error: null,
				},
			};
		}
		case "clone-directory-selected": {
			if (state.step.kind !== "clone") return state;
			return {
				...state,
				step: {
					...state.step,
					phase: "picking",
					cloneDirectory: action.directory,
					error: null,
				},
			};
		}
		case "clone-failed": {
			if (state.step.kind !== "clone") return state;
			return {
				...state,
				step: { ...state.step, phase: "idle", error: action.message },
			};
		}
		case "clone-succeeded": {
			if (state.step.kind !== "clone") return state;
			return {
				...state,
				step: {
					kind: "prompt",
					input: state.step.input,
					draftPrompt: "",
					existing: null,
					repoId: action.repoId,
				},
			};
		}
		case "edit-prompt": {
			if (state.step.kind !== "prompt") return state;
			return {
				...state,
				step: { ...state.step, draftPrompt: action.prompt },
			};
		}
		case "start-handoff": {
			if (state.step.kind !== "prompt") return state;
			if (!state.step.repoId) return state;
			return {
				...state,
				step: {
					kind: "handoff",
					input: state.step.input,
					draftPrompt: state.step.draftPrompt,
					repoId: state.step.repoId,
					error: null,
				},
			};
		}
		case "handoff-failed": {
			if (state.step.kind !== "handoff") return state;
			return {
				...state,
				step: { ...state.step, error: action.message },
			};
		}
		case "handoff-succeeded": {
			return {
				...state,
				step: {
					kind: "pr-hint",
					workspaceId: action.workspaceId,
					sessionId: action.sessionId,
				},
			};
		}
		case "reset": {
			return initialFeedbackState;
		}
	}
}

export function useFeedbackState() {
	return useReducer(reducer, initialFeedbackState);
}
