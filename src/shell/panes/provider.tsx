import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useReducer,
	type ReactNode,
} from "react";
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

export interface PanesContextValue {
	panes: Pane[];
	focusedPaneId: string | null;
	replaceTarget: (
		paneId: string,
		target: { workspaceId: string | null; sessionId: string | null },
	) => void;
}

const PanesContext = createContext<PanesContextValue | null>(null);

export function PanesProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(panesReducer, undefined, initialPanesState);

	const replaceTarget = useCallback<PanesContextValue["replaceTarget"]>(
		(paneId, target) => {
			dispatch({
				type: "replaceTarget",
				paneId,
				workspaceId: target.workspaceId,
				sessionId: target.sessionId,
			});
		},
		[],
	);

	const value = useMemo<PanesContextValue>(
		() => ({
			panes: state.panes,
			focusedPaneId: state.focusedPaneId,
			replaceTarget,
		}),
		[state, replaceTarget],
	);

	return <PanesContext.Provider value={value}>{children}</PanesContext.Provider>;
}

export function usePanes(): PanesContextValue {
	const value = useContext(PanesContext);
	if (!value) {
		throw new Error(
			"usePanes must be used inside <PanesProvider>. Check the provider tree.",
		);
	}
	return value;
}
