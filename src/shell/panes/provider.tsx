import type { Pane } from "./types";

export interface PanesState {
	panes: Pane[];
	focusedPaneId: string | null;
}

export type PanesAction = {
	type: "replaceTarget";
	paneId: string;
	workspaceId: string | null;
	sessionId: string | null;
};

export function initialPanesState(): PanesState {
	return {
		panes: [
			{ id: "default", workspaceId: null, sessionId: null, target: "main" },
		],
		focusedPaneId: "default",
	};
}

export function panesReducer(
	state: PanesState,
	action: PanesAction,
): PanesState {
	switch (action.type) {
		case "replaceTarget": {
			const index = state.panes.findIndex((pane) => pane.id === action.paneId);
			if (index === -1) return state;
			const pane = state.panes[index];
			if (
				pane.workspaceId === action.workspaceId &&
				pane.sessionId === action.sessionId
			) {
				return state;
			}
			const next = state.panes.slice();
			next[index] = {
				...pane,
				workspaceId: action.workspaceId,
				sessionId: action.sessionId,
			};
			return { ...state, panes: next };
		}
	}
}
