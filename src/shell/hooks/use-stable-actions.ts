// Two small primitives that keep "always-latest closure, but stable
// identity" cheap and unambiguous for the controller hooks in
// `shell/controllers/*`. Both ship as plain `.ts` so they don't drag
// in JSX/React types when imported transitively.
//
// `useLatestRef`     — mirror a value into a ref so async callbacks
//                      read the latest value, not a stale snapshot.
// `useStableActions` — wrap a bag of methods so every call forwards
//                      to the latest closure while the returned
//                      object's identity is stable forever. Use for
//                      "actions" objects that downstream
//                      `useCallback` / `useEffect` deps shouldn't
//                      churn on.
import { useMemo, useRef } from "react";

export function useLatestRef<T>(value: T): { readonly current: T } {
	const ref = useRef(value);
	ref.current = value;
	return ref;
}

// `(...args: never[]) => unknown` accepts any function signature in
// `extends`-position — TS uses `never` as the bottom of contravariant
// param positions, so concrete signatures (including Dispatch /
// async returns) flow in fine. The returned wrapper keeps each
// method's static type via `T[typeof key]`.
export function useStableActions<
	T extends Record<string, (...args: never[]) => unknown>,
>(live: T): T {
	const ref = useLatestRef(live);
	// Keys are frozen at first render — every controller that uses
	// this passes a literal object whose shape doesn't change between
	// renders. Stable identity is the whole point of the helper, so
	// `[]` is the correct deps array; each method forwards through
	// `ref.current` to the latest closure on every call.
	return useMemo(() => {
		const stable: Record<string, unknown> = {};
		for (const key of Object.keys(live)) {
			stable[key] = (...args: unknown[]) =>
				(ref.current[key] as (...args: unknown[]) => unknown)(...args);
		}
		return stable as T;
	}, []);
}
