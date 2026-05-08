/** Auto-pick defaults for the Cursor models picker: Auto + latest GPT
 *  + latest Claude. "Latest" = highest parsed version, ties broken by
 *  shortest id (prefers base variants over `*-mini`/`*-max`). */

import type { CursorModelEntry } from "@/lib/api";

/// Defaults for first-time `enabledModelIds === null`; never re-fires.
export function pickDefaultCursorModelIds(
	models: readonly CursorModelEntry[],
): string[] {
	const out: string[] = [];

	const auto = models.find(
		(m) => m.id === "default" || m.id.toLowerCase() === "auto",
	);
	if (auto) out.push(auto.id);

	const gpt = pickLatest(models, /^gpt-/);
	if (gpt) out.push(gpt.id);

	const claude = pickLatest(models, /^claude-/);
	if (claude) out.push(claude.id);

	// Never empty when catalog isn't.
	if (out.length === 0 && models.length > 0) {
		out.push(models[0]!.id);
	}
	return out;
}

function pickLatest(
	models: readonly CursorModelEntry[],
	pattern: RegExp,
): CursorModelEntry | null {
	const matches = models
		.filter((m) => pattern.test(m.id))
		.map((m) => ({ model: m, version: extractVersion(m.id) }))
		.sort((a, b) => compareVersions(b.version, a.version));
	if (matches.length === 0) return null;
	const top = matches[0]!.version;
	const tied = matches.filter((m) => compareVersions(m.version, top) === 0);
	// Tie-break: shortest id wins (prefers base over `*-mini`/`*-max`).
	tied.sort((a, b) => a.model.id.length - b.model.id.length);
	return tied[0]!.model;
}

/// First digit run as version array. `[0]` if none. e.g.
/// `gpt-5.3-codex → [5,3]`, `claude-sonnet-4-5 → [4,5]`.
export function extractVersion(id: string): number[] {
	const m = id.match(/\d+(?:[-.]\d+)*/);
	if (!m) return [0];
	return m[0].split(/[-.]/).map((s) => Number.parseInt(s, 10) || 0);
}

/// Component-wise compare, zero-padded missing slots.
export function compareVersions(a: number[], b: number[]): number {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
