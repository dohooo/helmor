/**
 * Whether the @-mention menu offers the "agent" entry. R5-A (D 项): the
 * @agent mention is a TEAM concept — in local single-user mode every message
 * already goes to the agent, so the entry only shows under team mode.
 * `teamActive` is passed in (rather than read here) to keep this pure and
 * unit-testable; the caller passes `isTeamModeActive()`.
 */
export function shouldIncludeAgentMentionOption(
	query: string,
	teamActive: boolean,
): boolean {
	if (!teamActive) return false;
	const q = query.trim().toLowerCase();
	return !q || "agent".includes(q);
}
