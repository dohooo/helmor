// Cloud-error recovery CTA classifier (team mode only).
//
// The Rust agent-stream error wire carries only a human-readable message
// string (no structured code — adding one would pull the snapshot-covered
// `AgentStreamEvent::Error` shape into scope, which the plan rules out). So
// the composer infers the recovery action from that message text alone, with
// a deliberately CONSERVATIVE substring match on the cloud-identity broker's
// known failure phrasings. Anything unrecognized returns `null` (plain error
// box, no button). Single-user never calls this (gated on `isTeamModeActive`).

export type CloudErrorCta = "auth" | "billing";

// Lowercased substrings that mark a cloud-identity auth failure (token
// missing / expired / not authorized → "Re-authorize").
const AUTH_PHRASES = [
	"unauthorized",
	"401",
	"no cloud identity",
	"needs re-authorization",
	"token expired",
];

// Lowercased substrings that mark a subscription/billing problem
// (→ "View Team settings").
const BILLING_PHRASES = ["agent sdk credit", "billing"];

/**
 * Classify a cloud send-error message into a recovery CTA, or `null` when the
 * message doesn't match a known cloud-identity failure. Auth is checked first
 * (re-auth is the more actionable fix). Case-insensitive substring match.
 */
export function classifyCloudError(
	message: string | null | undefined,
): CloudErrorCta | null {
	if (!message) return null;
	const text = message.toLowerCase();
	if (AUTH_PHRASES.some((phrase) => text.includes(phrase))) return "auth";
	if (BILLING_PHRASES.some((phrase) => text.includes(phrase))) return "billing";
	return null;
}

/**
 * Map a RAW cloud send/stream error into friendlier composer copy. WP2 smoke
 * surfaced two unfriendly strings: the browser's network "Load failed" (Worker
 * unreachable / CORS) and the Worker's permanent container-start error. Anything
 * else passes through unchanged (Rust/Worker messages are already human-readable).
 * Team-mode only — single-user never calls this.
 */
export function describeCloudError(message: string | null | undefined): string {
	const raw = (message ?? "").trim();
	if (!raw) return "The cloud run failed. Please try again.";
	const text = raw.toLowerCase();
	if (text.includes("permanent error") || text.includes("failed to start")) {
		return "The team sandbox can't start — its container is failing to boot. Re-run Team setup, or check the sandbox image + Cloudflare Containers plan in Settings → Team.";
	}
	if (
		text === "load failed" ||
		text.includes("failed to fetch") ||
		text.includes("networkerror") ||
		text.includes("network error")
	) {
		return "Can't reach the team cloud — it may be offline, still waking, or the URL is wrong. Check your connection, then retry.";
	}
	return raw;
}
