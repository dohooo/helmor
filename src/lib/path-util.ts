/**
 * Cross-platform path helpers for display purposes.
 *
 * User-pasted paths on Windows use backslashes (`C:\Users\me\file.png`).
 * The existing `split("/").pop()` pattern dotted around the frontend
 * returns the entire path in that case. `basename` here normalizes
 * separators first so all platforms produce the same display string.
 *
 * Intentionally minimal — this is for UI display only, not for joining
 * paths or filesystem operations. The Rust side should always be the
 * source of truth for real path operations.
 */

/** Return the final path segment, handling both `/` and `\` separators. */
export function basename(path: string): string {
	if (!path) return path;
	const normalized = path.replace(/\\/g, "/");
	const segments = normalized.split("/");
	return segments[segments.length - 1] || path;
}
