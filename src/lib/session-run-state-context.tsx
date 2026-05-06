import { createContext, useContext, useMemo } from "react";
import {
	deriveBusySessionIds,
	deriveStoppableSessionIds,
	type SessionRunState,
} from "./session-run-state";

const EMPTY_STATES: ReadonlyMap<string, SessionRunState> = new Map();

const SessionRunStatesContext =
	createContext<ReadonlyMap<string, SessionRunState>>(EMPTY_STATES);

export const SessionRunStatesProvider = SessionRunStatesContext.Provider;

export function useSessionRunStates(): ReadonlyMap<string, SessionRunState> {
	return useContext(SessionRunStatesContext);
}

export function useBusySessionIds(): ReadonlySet<string> {
	const states = useSessionRunStates();
	return useMemo(() => deriveBusySessionIds(states), [states]);
}

export function useStoppableSessionIds(): ReadonlySet<string> {
	const states = useSessionRunStates();
	return useMemo(() => deriveStoppableSessionIds(states), [states]);
}
