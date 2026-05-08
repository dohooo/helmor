/**
 * Helpers for the Cursor models settings panel — version parsing and the
 * "auto-pick" logic that runs once when the user first saves an API key
 * (or any time `enabledModelIds` is `null` and a fetch succeeds).
 *
 * Defaults: Auto (id="default") + latest GPT + latest Claude. "Latest" is
 * highest version number parsed out of the model id; ties broken by
 * shortest id (prefers the base variant over `*-mini`/`*-max`).
 */

import type { CursorModelEntry } from "@/lib/api";

/// Compute the default `enabledModelIds` from a freshly fetched cursor
/// model list. Called once when the user saves an API key with
/// `enabledModelIds === null`. Subsequent saves never auto-fill; the
/// user is in charge.
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

	// Hard fallback: never return an empty list when at least one model
	// matched anywhere. If the entire upstream catalog is empty (very
	// unusual) the caller decides what to do.
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
	// Tie-break: shortest id wins. Prefers `gpt-5.3-codex` over
	// `gpt-5.3-codex-mini` and `claude-sonnet-4-5` over any longer suffix.
	tied.sort((a, b) => a.model.id.length - b.model.id.length);
	return tied[0]!.model;
}

/// Pull the first digit-dot-or-dash-separated number sequence out of a
/// model id. e.g. `gpt-5.3-codex → [5, 3]`, `claude-sonnet-4-5 → [4, 5]`,
/// `composer-2 → [2]`. Returns `[0]` when no digit run exists.
export function extractVersion(id: string): number[] {
	const m = id.match(/\d+(?:[-.]\d+)*/);
	if (!m) return [0];
	return m[0].split(/[-.]/).map((s) => Number.parseInt(s, 10) || 0);
}

/// Compare two version arrays component-wise, missing slots zero-padded.
export function compareVersions(a: number[], b: number[]): number {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
