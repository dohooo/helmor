import { useReducer } from "react";

import type { ExistingHelmorRepo } from "@/lib/api";

/**
 * Feedback dialog state machine. Three meaningful steps:
 *
 *   input  → user types feedback + chooses Create issue / Quick fix
 *   clone  → fork + pick a folder + clone (skipped when a local helmor
 *            repo already exists)
 *   prompt → refine the prompt; Send to agent invokes
 *            `onSubmitPrompt(repoId, prompt)` which lives outside this
 *            reducer and closes the dialog when done — no further steps
 *            are needed because the conversation hook auto-fires the
 *            prompt the moment the workspace mounts.
 *
 * "Create issue" is fire-and-forget — the dialog stays in `input` while
 * the API call runs and toasts the result.
 */
export type FeedbackStep =
	| { kind: "input"; input: string }
	| {
			kind: "clone";
			input: string;
			phase: "idle" | "forking" | "picking" | "cloning";
			forkedCloneUrl: string | null;
			cloneDirectory: string | null;
			error: string | null;
	  }
	| {
			kind: "prompt";
			input: string;
			draftPrompt: string;
			existing: ExistingHelmorRepo | null;
			repoId: string | null;
	  };

export type FeedbackAction =
	| { type: "set-input"; input: string }
	| {
			type: "start-quick-fix";
			existing: ExistingHelmorRepo | null;
	  }
	| { type: "clone-phase"; phase: "forking" | "picking" | "cloning" | "idle" }
	| { type: "clone-fork-succeeded"; cloneUrl: string }
	| { type: "clone-directory-selected"; directory: string }
	| { type: "clone-failed"; message: string }
	| { type: "clone-succeeded"; repoId: string }
	| { type: "edit-prompt"; prompt: string }
	| { type: "reset" };

const initialStep: FeedbackStep = { kind: "input", input: "" };

function reducer(state: FeedbackStep, action: FeedbackAction): FeedbackStep {
	switch (action.type) {
		case "set-input": {
			if (state.kind !== "input") return state;
			return { ...state, input: action.input };
		}
		case "start-quick-fix": {
			if (state.kind !== "input") return state;
			if (action.existing) {
				return {
					kind: "prompt",
					input: state.input,
					draftPrompt: "",
					existing: action.existing,
					repoId: action.existing.repoId,
				};
			}
			return {
				kind: "clone",
				input: state.input,
				phase: "forking",
				forkedCloneUrl: null,
				cloneDirectory: null,
				error: null,
			};
		}
		case "clone-phase": {
			if (state.kind !== "clone") return state;
			return { ...state, phase: action.phase, error: null };
		}
		case "clone-fork-succeeded": {
			if (state.kind !== "clone") return state;
			return {
				...state,
				phase: "picking",
				forkedCloneUrl: action.cloneUrl,
				error: null,
			};
		}
		case "clone-directory-selected": {
			if (state.kind !== "clone") return state;
			return {
				...state,
				phase: "picking",
				cloneDirectory: action.directory,
				error: null,
			};
		}
		case "clone-failed": {
			if (state.kind !== "clone") return state;
			return { ...state, phase: "idle", error: action.message };
		}
		case "clone-succeeded": {
			if (state.kind !== "clone") return state;
			return {
				kind: "prompt",
				input: state.input,
				draftPrompt: "",
				existing: null,
				repoId: action.repoId,
			};
		}
		case "edit-prompt": {
			if (state.kind !== "prompt") return state;
			return { ...state, draftPrompt: action.prompt };
		}
		case "reset": {
			return initialStep;
		}
	}
}

export function useFeedbackState() {
	const [step, dispatch] = useReducer(reducer, initialStep);
	return [{ step }, dispatch] as const;
}
