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
import { formatSource, translateSource } from "@/lib/i18n";

export function validateBranchName(
	raw: string,
	existing: ReadonlyArray<string> = [],
): string | null {
	const value = raw.trim();
	if (value.length === 0) return translateSource("miscBranchNameCannotBeEmpty");
	if (value.endsWith("/"))
		return translateSource("miscBranchNameCannotEndWithSlash");
	if (value.startsWith("/") || value.startsWith(".") || value.startsWith("-")) {
		return translateSource("miscBranchNameCannotStartWith");
	}
	if (value.includes(".."))
		return translateSource("miscBranchNameCannotContainDots");
	if (/\s/.test(value))
		return translateSource("miscBranchNameCannotContainWhitespace");
	if (/[~^:?*[\\]/.test(value)) {
		return translateSource("miscBranchNameInvalidCharacter");
	}
	if (value.endsWith(".lock"))
		return translateSource("miscBranchNameCannotEndWithLock");
	if (value.includes("@{"))
		return translateSource("miscBranchNameCannotContainAtBrace");
	if (existing.some((existingName) => existingName === value)) {
		return formatSource("miscBranchNamedAlreadyExists", { value });
	}
	return null;
}
