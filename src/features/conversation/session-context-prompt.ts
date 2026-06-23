export type SessionContextReference = {
	id: string;
	title: string;
	workspaceId: string;
};

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function buildCommand(command: string): string {
	return `the exact Helmor CLI invocation shown in <helmor_context>, followed by \`${command}\``;
}

export function buildSessionContextPrompt(
	references: readonly SessionContextReference[],
): string | null {
	const uniqueReferences = references.filter(
		(reference, index, all) =>
			reference.id.trim().length > 0 &&
			all.findIndex((candidate) => candidate.id === reference.id) === index,
	);
	if (uniqueReferences.length === 0) {
		return null;
	}

	const tags = uniqueReferences
		.map((reference) => {
			const title = reference.title.trim() || "Untitled";
			const sessionId = escapeAttribute(reference.id);
			const workspaceId = escapeAttribute(reference.workspaceId);
			const label = escapeText(title);
			return [
				`<helmor-session-ref session-id="${sessionId}" workspace-id="${workspaceId}" title="${escapeAttribute(title)}">`,
				`The user selected prior session "${label}" as reference context. Its transcript is not included here.`,
				`Start by reading the latest window with ${buildCommand(`session get-messages ${reference.id} --position tail --limit 12 --body-limit 2000 --json`)}.`,
				`If that does not reveal the original goal or constraints, read the beginning with ${buildCommand(`session get-messages ${reference.id} --position head --limit 8 --body-limit 2000 --json`)}.`,
				`The JSON output is an envelope; inspect its \`messages\` array plus \`windowHasMore\`, \`bodyHasMore\`, \`bodyOffset\`, and \`bodyTotal\`. If a relevant message is truncated, do one targeted refetch, for example ${buildCommand(`session get-messages ${reference.id} --position tail --limit 5 --body-limit 4000 --body-position end --json`)}.`,
				`If command syntax is unclear, run ${buildCommand("session get-messages --help")}.`,
				"</helmor-session-ref>",
			].join("\n");
		})
		.join("\n");

	return [
		"<helmor-session-context>",
		"The user explicitly selected prior Helmor sessions to inject as context for this new session. Their transcripts are not included in this prompt. Before giving a substantive answer for this turn, inspect the selected sessions with the Helmor CLI; do not answer from memory, the workspace preamble, or visible session titles alone.",
		tags,
		"<read-strategy>",
		"For each selected session, read the minimum bounded slices needed to answer or continue the work. Start with the tail to recover current state, completed work, blockers, and next likely step. Read the head when you need the original goal or constraints. Continue with targeted slices until you can state the prior goal, important decisions, completed work, unresolved blockers, and next concrete action. Stop once you have enough context; do not dump entire transcripts by default. If selected sessions conflict or remain unclear after targeted reads, say what you could verify and ask the user what should carry over.",
		"</read-strategy>",
		"</helmor-session-context>",
	].join("\n");
}
