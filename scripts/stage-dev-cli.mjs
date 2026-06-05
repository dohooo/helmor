#!/usr/bin/env node
/**
 * Dev-only CLI staging.
 *
 * `tauri dev`'s `beforeDevCommand` is just Vite — unlike `tauri build` it never
 * runs `prepare-sidecar.mjs`, so nothing stages the companion `helmor-cli`.
 * Without this step `build.rs`'s `externalBin` placeholder (`#!/bin/sh; exit 0`)
 * is what Tauri copies to `target/debug/helmor-cli`: the dev CLI then runs,
 * prints nothing, and any agent told to drive `helmor` from the terminal
 * silently gets no output (e.g. `helmor workspace stack` can't run at all).
 *
 * This builds the debug `helmor-cli` and stages it as the target-suffixed
 * external bin Tauri ingests, so the dev build lands a REAL CLI at
 * `target/debug/helmor-cli`. Combined with the app's startup symlink self-heal,
 * a plain `bun run dev` restart fixes the dev CLI instead of a manual rebuild.
 */
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauriDir = resolve(repoRoot, "src-tauri");
const bundledBinDir = resolve(srcTauriDir, "target", "bundled");
const cliName = process.platform === "win32" ? "helmor-cli.exe" : "helmor-cli";

function detectTargetTriple() {
	for (const key of [
		"TAURI_TARGET_TRIPLE",
		"TAURI_ENV_TARGET_TRIPLE",
		"CARGO_BUILD_TARGET",
	]) {
		const override = process.env[key]?.trim();
		if (override) {
			return override;
		}
	}
	const triple = execSync("rustc --print host-tuple", {
		encoding: "utf8",
	}).trim();
	if (!triple) {
		throw new Error("`rustc --print host-tuple` returned empty output");
	}
	return triple;
}

const triple = detectTargetTriple();
const builtCli = resolve(srcTauriDir, "target", "debug", cliName);
const stagedCli = resolve(bundledBinDir, `helmor-cli-${triple}`);

// Force cargo to re-link the top-level binary even when the compile is cached:
// the stale artifact sitting here is `build.rs`'s no-op shell placeholder, and
// it must not survive as the "built" CLI.
rmSync(builtCli, { force: true });

console.log("[stage-dev-cli] building debug helmor-cli…");
execFileSync(
	"cargo",
	[
		"build",
		"--manifest-path",
		resolve(srcTauriDir, "Cargo.toml"),
		"--bin",
		"helmor-cli",
	],
	{ stdio: "inherit" },
);

// Guard: if the placeholder somehow survived the build, fail loudly rather than
// stage a silent no-op CLI.
const head = readFileSync(builtCli).subarray(0, 16).toString("latin1");
if (head.startsWith("#!/bin/sh")) {
	throw new Error(
		`[stage-dev-cli] ${builtCli} is still the build.rs placeholder after build`,
	);
}

mkdirSync(bundledBinDir, { recursive: true });
copyFileSync(builtCli, stagedCli);
console.log(`[stage-dev-cli] staged ${builtCli} → ${stagedCli}`);
