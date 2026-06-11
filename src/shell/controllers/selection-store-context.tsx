// Thin context exposing the selection controller's instance-level store so
// panes can subscribe to individual selection-field selectors instead of
// receiving flattened props from AppShell. The store itself is the single
// atomic source of truth (selected/displayed tracks + viewMode/reselectTick)
// written in lockstep by the controller's actions — this context only carries
// the `StoreApi` reference; it never owns or mutates state.
import { createContext, useContext } from "react";
import type { SelectionStore } from "./use-selection-controller";

const SelectionStoreContext = createContext<SelectionStore | null>(null);

export const SelectionStoreProvider = SelectionStoreContext.Provider;

export function useSelectionStore(): SelectionStore {
	const store = useContext(SelectionStoreContext);
	if (store === null) {
		throw new Error(
			"useSelectionStore() called outside <SelectionStoreProvider>.",
		);
	}
	return store;
}
