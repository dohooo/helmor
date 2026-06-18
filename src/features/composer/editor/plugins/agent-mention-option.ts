export function shouldIncludeAgentMentionOption(query: string): boolean {
	const q = query.trim().toLowerCase();
	return !q || "agent".includes(q);
}
