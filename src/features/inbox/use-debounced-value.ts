import { useEffect, useState } from "react";

/** Returns `value` delayed by `delayMs`. Resets the timer on every
 *  change so rapid keystrokes only fire one downstream update. Used
 *  inside the inbox to keep the search box from firing a Slack /
 *  forge query per keystroke. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debouncedValue, setDebouncedValue] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
		return () => window.clearTimeout(timer);
	}, [value, delayMs]);
	return debouncedValue;
}
