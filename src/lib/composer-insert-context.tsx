import { createContext, useContext } from "react";
import type { ComposerInsertRequest } from "./composer-insert";

export type InsertIntoComposer = (request: ComposerInsertRequest) => void;

const noop: InsertIntoComposer = import.meta.env.DEV
	? (request) => {
			console.warn(
				"useComposerInsert() called outside <ComposerInsertProvider>. Insert silently dropped:",
				request,
			);
		}
	: () => {};

const ComposerInsertContext = createContext<InsertIntoComposer>(noop);

export const ComposerInsertProvider = ComposerInsertContext.Provider;

export function useComposerInsert(): InsertIntoComposer {
	return useContext(ComposerInsertContext);
}
