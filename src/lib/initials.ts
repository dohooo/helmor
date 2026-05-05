/// Avatar fallback initials. Used inside `<AvatarFallback>` when the
/// live avatar URL fails to load (e.g. self-hosted GitLab gating
/// `/uploads/` behind a session cookie our PAT can't satisfy).
///
/// Rules:
///   - Single token (no whitespace) → first letter, e.g. "octocat" → "O"
///   - Multiple tokens → first letter of each, capped at 2,
///     e.g. "Nathan L" → "NL", "Ada Catherine Lovelace" → "AC"
///   - Empty input → "?" so the slot never renders blank.

export function initialsFor(value: string | null | undefined): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return "?";
	const parts = trimmed.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) {
		return parts[0].charAt(0).toUpperCase();
	}
	return parts
		.slice(0, 2)
		.map((part) => part.charAt(0).toUpperCase())
		.join("");
}
