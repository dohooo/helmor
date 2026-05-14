import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureCodexGoalsFeatureEnabled,
	injectGoalsFeature,
} from "./codex-config.js";

describe("injectGoalsFeature", () => {
	test("creates a fresh file body when content is null", () => {
		expect(injectGoalsFeature(null)).toBe("[features]\ngoals = true\n");
	});

	test("creates a fresh file body when content is empty", () => {
		expect(injectGoalsFeature("")).toBe("[features]\ngoals = true\n");
	});

	test("returns null when goals = true is already present", () => {
		const input = "[features]\ngoals = true\n";
		expect(injectGoalsFeature(input)).toBeNull();
	});

	test("returns null when goals = true sits among other feature flags", () => {
		const input = "[features]\nmcp = true\ngoals = true\nother = false\n";
		expect(injectGoalsFeature(input)).toBeNull();
	});

	test("appends [features] section with a blank-line separator", () => {
		const input = "[other]\nfoo = 1\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe("[other]\nfoo = 1\n\n[features]\ngoals = true\n");
	});

	test("appends [features] section when file lacks trailing newline", () => {
		const input = "[other]\nfoo = 1";
		const out = injectGoalsFeature(input);
		expect(out).toBe("[other]\nfoo = 1\n\n[features]\ngoals = true\n");
	});

	test("inserts goals key under existing [features] section", () => {
		const input = "[features]\nmcp = true\n\n[other]\nfoo = 1\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe(
			"[features]\ngoals = true\nmcp = true\n\n[other]\nfoo = 1\n",
		);
	});

	test("inserts goals key when [features] is the only section", () => {
		const input = "[features]\nmcp = true\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe("[features]\ngoals = true\nmcp = true\n");
	});

	test("flips goals = false to true in place", () => {
		const input = "[features]\ngoals = false\nmcp = true\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe("[features]\ngoals = true\nmcp = true\n");
	});

	test("ignores `goals` keys inside other sections", () => {
		const input = "[other]\ngoals = true\n\n[features]\nmcp = true\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe(
			"[other]\ngoals = true\n\n[features]\ngoals = true\nmcp = true\n",
		);
	});

	test("treats subtables like [features.something] as ending the section", () => {
		const input = "[features]\n[features.experimental]\nfoo = 1\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe(
			"[features]\ngoals = true\n[features.experimental]\nfoo = 1\n",
		);
	});

	test("preserves CRLF line endings", () => {
		const input = "[other]\r\nfoo = 1\r\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe(
			"[other]\r\nfoo = 1\r\n\r\n[features]\r\ngoals = true\r\n",
		);
	});

	test("preserves comments inside [features]", () => {
		const input = "[features]\n# experimental knobs\nmcp = true\n";
		const out = injectGoalsFeature(input);
		expect(out).toBe(
			"[features]\ngoals = true\n# experimental knobs\nmcp = true\n",
		);
	});
});

describe("ensureCodexGoalsFeatureEnabled", () => {
	test("creates the config file when missing", async () => {
		const dir = await mkTmpDir();
		const path = join(dir, "config.toml");
		const result = await ensureCodexGoalsFeatureEnabled(path);
		expect(result).toEqual({ kind: "modified", path });
		expect(await readFile(path, "utf8")).toBe("[features]\ngoals = true\n");
	});

	test("flips an existing disabled flag", async () => {
		const dir = await mkTmpDir();
		const path = join(dir, "config.toml");
		await writeFile(path, "[features]\ngoals = false\n", "utf8");
		const result = await ensureCodexGoalsFeatureEnabled(path);
		expect(result).toEqual({ kind: "modified", path });
		expect(await readFile(path, "utf8")).toBe("[features]\ngoals = true\n");
	});

	test("reports alreadyEnabled when config is correct", async () => {
		const dir = await mkTmpDir();
		const path = join(dir, "config.toml");
		await writeFile(path, "[features]\ngoals = true\n", "utf8");
		const result = await ensureCodexGoalsFeatureEnabled(path);
		expect(result).toEqual({ kind: "alreadyEnabled", path });
	});
});

async function mkTmpDir(): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	return mkdtemp(join(tmpdir(), "helmor-codex-config-"));
}
