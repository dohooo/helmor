// Edits `~/.codex/config.toml` to flip on the experimental `goals` feature.
// `thread/goal/set` errors with "goals feature is disabled" when the flag
// is missing.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EnableGoalsResult =
	| { kind: "alreadyEnabled"; path: string }
	| { kind: "modified"; path: string };

export function codexConfigPath(): string {
	const override = process.env.CODEX_HOME?.trim();
	const home =
		override && override.length > 0 ? override : join(homedir(), ".codex");
	return join(home, "config.toml");
}

export async function ensureCodexGoalsFeatureEnabled(
	path: string = codexConfigPath(),
): Promise<EnableGoalsResult> {
	let original: string | null = null;
	try {
		original = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
	}

	const updated = injectGoalsFeature(original);
	if (updated === null) {
		return { kind: "alreadyEnabled", path };
	}

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, updated, "utf8");
	return { kind: "modified", path };
}

// Line-based mutator: only touches the `goals` key under the top-level
// `[features]` table. Returns null when no rewrite is needed. Inline-table
// (`features = { goals = true }`) and dotted-key (`features.goals = true`)
// forms aren't detected — codex's error path implies neither is set.
export function injectGoalsFeature(content: string | null): string | null {
	if (content === null || content === "") {
		return "[features]\ngoals = true\n";
	}

	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);

	let featuresStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === "[features]") {
			featuresStart = i;
			break;
		}
	}

	if (featuresStart === -1) {
		const trailingNewline = /\r?\n$/.test(content);
		const sep = trailingNewline ? "" : eol;
		const blank = content.length === 0 ? "" : eol;
		return `${content}${sep}${blank}[features]${eol}goals = true${eol}`;
	}

	let goalsLine = -1;
	for (let i = featuresStart + 1; i < lines.length; i++) {
		const trimmed = (lines[i] ?? "").trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
		const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
		if (keyMatch && keyMatch[1] === "goals") {
			goalsLine = i;
			break;
		}
	}

	if (goalsLine !== -1) {
		const existing = lines[goalsLine] ?? "";
		const value = existing.split("=").slice(1).join("=").trim();
		if (value === "true") return null;
		lines[goalsLine] = "goals = true";
		return lines.join(eol);
	}

	lines.splice(featuresStart + 1, 0, "goals = true");
	return lines.join(eol);
}
