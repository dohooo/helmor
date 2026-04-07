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
