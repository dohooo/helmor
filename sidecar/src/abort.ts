/**
 * Detect AbortController-induced errors.
 *
 * Neither the Claude Agent SDK nor the Codex SDK exposes a typed abort
 * error class, so we sniff the standard runtime shapes. This is the only
 * place in the sidecar where string-sniffing is acceptable — once an
 * abort is detected here, it crosses the wire as a typed `aborted` event.
 */
export function isAbortError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: unknown; code?: unknown; message?: unknown };
	if (e.name === "AbortError") return true;
	if (e.code === "ABORT_ERR") return true;
	if (typeof e.message === "string" && /abort/i.test(e.message)) return true;
	return false;
}

/**
 * Detect "Query closed before response received" — a transient Claude SDK
 * race where the claude-code child is torn down (session swap, child exit)
 * between a control-protocol request and its reply. Caller retries once.
 */
export function isQueryClosedTransient(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const msg = (err as { message?: unknown }).message;
	return (
		typeof msg === "string" && msg.includes("Query closed before response")
	);
}
