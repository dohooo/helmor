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
