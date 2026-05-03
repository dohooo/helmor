const WHITESPACE_RE = /\s+/g;

export function normalizeBranchRenameInput(value: string): string {
	return value.trim().replace(WHITESPACE_RE, "-");
}
