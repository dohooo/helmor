// Module augmentation for TanStack Query's `meta` field. Keeps the
// shape closed so typos like `presist` fail at compile time.
//
// `persist: true` opts a query into the on-disk cache. See
// `createHelmorQueryClient` in `query-client.ts` for the wiring and
// AGENTS.md ("Persisting React Query data") for the guideline.
import "@tanstack/react-query";

declare module "@tanstack/react-query" {
	interface Register {
		queryMeta: { persist?: true };
	}
}
