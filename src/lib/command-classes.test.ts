// R3-A drift guard: every command the frontend `invoke()`s must be classified
// in COMMAND_CLASSES, and every classified command must still exist. This is
// the frontend equivalent of src-tauri/tests/companion_dispatch_coverage.rs —
// the mechanism that makes "new code is born free" hold: an unclassified
// command fails HERE at PR time, instead of silently burning container hours
// until someone reads the bill.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_CLASSES, LOCAL_ONLY_COMMANDS } from "./command-classes";

/** Pull every `invoke("name")` / `invoke<T>("name")` command name out of a
 *  TypeScript source. Mirrors `extract_invoke_names` in
 *  companion_dispatch_coverage.rs (plus nested-generic support). */
function extractInvokeNames(src: string, out: Set<string>): void {
	const re = /(?<![A-Za-z0-9_])invoke(?:<[^(]*?>)?\s*\(\s*"([a-z0-9_]+)"/g;
	for (const match of src.matchAll(re)) {
		const name = match[1];
		if (/^[a-z][a-z0-9_]*$/.test(name)) out.add(name);
	}
}

function collectTsFiles(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			// Skip the test-support dir (mocks `invoke` with phantom commands).
			if (name === "test") continue;
			collectTsFiles(path, out);
		} else if (
			(name.endsWith(".ts") || name.endsWith(".tsx")) &&
			!name.includes(".test.")
		) {
			out.push(path);
		}
	}
}

function scanFrontendInvokes(): Set<string> {
	const files: string[] = [];
	collectTsFiles(join(process.cwd(), "src"), files);
	expect(files.length).toBeGreaterThan(0);
	const names = new Set<string>();
	for (const file of files) {
		extractInvokeNames(readFileSync(file, "utf8"), names);
	}
	// Scanner self-check: a broken regex would "pass" vacuously.
	expect(names.size).toBeGreaterThan(100);
	return names;
}

describe("command-classes registry", () => {
	it("classifies every frontend invoke() command", () => {
		const invoked = scanFrontendInvokes();
		const unclassified = [...invoked]
			.filter((cmd) => !(cmd in COMMAND_CLASSES))
			.sort();
		expect(
			unclassified,
			`Unclassified invoke() command(s): ${unclassified.join(", ")}\n\n` +
				"Every command must declare what it may cost in team mode. Add it to " +
				"COMMAND_CLASSES in src/lib/command-classes.ts:\n" +
				"  - PASSIVE (default): read/micro-write — free, returns stale while the sandbox sleeps\n" +
				"  - WAKE: explicit user work — allowed to cold-start + keep the container awake\n" +
				"  - CONTROL_PLANE: served by Worker/D1/TeamHub without the container\n" +
				"  - LOCAL_ONLY: must run on this Mac's Tauri host\n" +
				"Defaulting to PASSIVE is safe; WAKE is a product decision.",
		).toEqual([]);
	});

	it("has no stale registry entries (classified but never invoked)", () => {
		const invoked = scanFrontendInvokes();
		const stale = Object.keys(COMMAND_CLASSES)
			.filter((cmd) => !invoked.has(cmd))
			.sort();
		expect(
			stale,
			`Stale COMMAND_CLASSES entr(ies) no frontend code invokes: ${stale.join(", ")} — remove them.`,
		).toEqual([]);
	});

	it("flags an unclassified command (guard self-test)", () => {
		// Prove the extraction actually catches a fresh invoke("...") — the
		// polarity the registry exists for.
		const names = new Set<string>();
		extractInvokeNames(
			`await invoke<Foo<Bar, Baz>>("some_brand_new_command", { x: 1 })`,
			names,
		);
		expect(names.has("some_brand_new_command")).toBe(true);
		expect("some_brand_new_command" in COMMAND_CLASSES).toBe(false);
	});

	it("derives LOCAL_ONLY_COMMANDS from the registry", () => {
		expect(LOCAL_ONLY_COMMANDS.size).toBeGreaterThan(0);
		for (const cmd of LOCAL_ONLY_COMMANDS) {
			expect(COMMAND_CLASSES[cmd]).toBe("LOCAL_ONLY");
		}
		// The R3-A reclassification that motivated the registry: editors live
		// on this Mac, never the container.
		expect(LOCAL_ONLY_COMMANDS.has("detect_installed_editors")).toBe(true);
	});
});
