/**
 * Pure helper: detect whether a message text contains an @agent mention.
 *
 * Rules (per spec §PART 3 — ROOM B · PLUMBING, Bp-a):
 * - Case-insensitive match anywhere in the text.
 * - The literal string `@agent` is dispatched to the agent; any message
 *   without it is room chat (broadcast + persisted, NOT sent to the agent).
 * - TEAM MODE ONLY — callers must gate on `isTeamModeActive()` before
 *   checking this; single-user mode is byte-identical and never reaches here.
 */
export function hasAgentMention(text: string): boolean {
	return /@agent/i.test(text);
}
