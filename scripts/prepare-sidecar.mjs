#!/usr/bin/env node
/**
 * Cross-platform sidecar staging script. Replaces the POSIX-only
 * `beforeBuildCommand` that previously used `cp`, `grep`, `cut`, and `$(...)`
 * subshells which do not work on `cmd.exe` / PowerShell.
 *
 * What it does:
 * 1. `cd sidecar && bun install --frozen-lockfile` (so CI runners have deps).
 * 2. `bun run build` — produces `sidecar/dist/helmor-sidecar[.exe]` plus the
 *    `sidecar/dist/vendor/` tree that Tauri bundles as resources.
 * 3. Copy `sidecar/dist/helmor-sidecar[.exe]` to
 *    `sidecar/dist/helmor-sidecar-<target-triple>[.exe]` so Tauri's
 *    `externalBin: ["../sidecar/dist/helmor-sidecar"]` can find the
 *    target-suffixed artifact it requires on every platform.
 *
 * Tauri invokes this via `beforeBuildCommand` on every platform. It uses
 * only Node stdlib — no POSIX shell assumptions.
 *
 * Usage (from repo root):
 *   node scripts/prepare-sidecar.mjs
 *   bun scripts/prepare-sidecar.mjs      # equivalent, Tauri uses this form
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = resolve(repoRoot, "sidecar");

function run(cmd, cwd) {
	console.log(`[prepare-sidecar] $ ${cmd} (cwd: ${cwd})`);
	execSync(cmd, { cwd, stdio: "inherit" });
}

function detectTargetTriple() {
	const override = process.env.TAURI_TARGET_TRIPLE?.trim();
	if (override) {
		return override;
	}
	const output = execSync("rustc --print host-tuple", {
		encoding: "utf8",
	}).trim();
	if (!output) {
		throw new Error("`rustc --print host-tuple` returned empty output");
	}
	return output;
}

function sidecarExtension() {
	return process.platform === "win32" ? ".exe" : "";
}

function main() {
	// 1. Install sidecar deps (idempotent; fast when lockfile matches).
	run("bun install --frozen-lockfile", sidecarDir);

	// 2. Build the compiled sidecar + staged vendor tree.
	run("bun run build", sidecarDir);

	const ext = sidecarExtension();
	const triple = detectTargetTriple();
	const source = resolve(sidecarDir, "dist", `helmor-sidecar${ext}`);
	const destination = resolve(
		sidecarDir,
		"dist",
		`helmor-sidecar-${triple}${ext}`,
	);

	if (!existsSync(source)) {
		// On some platforms (notably Windows when bun-compile stripped the
		// extension), the artifact may be named without `.exe`. Try the bare
		// name as a fallback so we produce a usable copy either way.
		const fallback = resolve(sidecarDir, "dist", "helmor-sidecar");
		if (!existsSync(fallback)) {
			throw new Error(
				`[prepare-sidecar] expected compiled sidecar at ${source} (or ${fallback}) but neither exists`,
			);
		}
		copyFileSync(fallback, destination);
	} else {
		copyFileSync(source, destination);
	}

	console.log(`[prepare-sidecar] staged → ${destination}`);
}

main();
