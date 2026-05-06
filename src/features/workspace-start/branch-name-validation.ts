/**
 * Frontend validation for git branch names. Mirrors the subset of
 * `git check-ref-format` rules that catch the common typos. Backend
 * still calls `git branch` itself (which enforces the full rule set),
 * so this is purely UX feedback while the user types.
 *
 * Exhaustive rules: see `man git-check-ref-format`. We deliberately
 * skip a few obscure ones (e.g. component cannot start with `+`,
 * cannot contain `\`) — the backend will reject them anyway.
 */
export function validateBranchName(
	raw: string,
	existing: ReadonlyArray<string> = [],
): string | null {
	const value = raw.trim();
	if (value.length === 0) return "Branch name cannot be empty.";
	if (value.endsWith("/")) return 'Branch name cannot end with "/".';
	if (value.startsWith("/") || value.startsWith(".") || value.startsWith("-")) {
		return 'Branch name cannot start with "/", "." or "-".';
	}
	if (value.includes("..")) return 'Branch name cannot contain "..".';
	if (/\s/.test(value)) return "Branch name cannot contain whitespace.";
	if (/[~^:?*[\\]/.test(value)) {
		return "Branch name contains an invalid character.";
	}
	if (value.endsWith(".lock")) return 'Branch name cannot end with ".lock".';
	if (value.includes("@{")) return 'Branch name cannot contain "@{".';
	if (existing.some((existingName) => existingName === value)) {
		return `A branch named "${value}" already exists.`;
	}
	return null;
}
