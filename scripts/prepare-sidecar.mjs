#!/usr/bin/env node
/**
 * Bundle-binary staging script. Tauri invokes this via `beforeBuildCommand`.
 *
 * Steps:
 * 1. `cd sidecar && bun install --frozen-lockfile` (so CI runners have deps).
 * 2. `bun run build` — produces `sidecar/dist/helmor-sidecar` plus the
 *    `sidecar/dist/vendor/` tree that Tauri bundles as resources.
 * 3. `cargo build --bin helmor-cli --release --target <triple>` — produces
 *    the CLI companion binary that ships inside the desktop app bundle.
 * 4. Copy the compiled sidecar / CLI to target-suffixed names so Tauri's
 *    `externalBin` entries can find the artifacts they expect.
 *
 * Usage (from repo root):
 *   node scripts/prepare-sidecar.mjs
 *   bun scripts/prepare-sidecar.mjs      # equivalent, Tauri uses this form
 */
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	resolveBundleArtifacts,
	resolveTargetTriple,
} from "./build-platform.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = resolve(repoRoot, "sidecar");
const srcTauriDir = resolve(repoRoot, "src-tauri");
const entitlementsPlist = resolve(repoRoot, "src-tauri", "Entitlements.plist");

function run(cmd, cwd) {
	console.log(`[prepare-sidecar] $ ${cmd} (cwd: ${cwd})`);
	execSync(cmd, { cwd, stdio: "inherit" });
}

// Pre-sign the compiled sidecar with JIT entitlements so Bun's JSC runtime
// can allocate executable memory under hardened runtime. Tauri may re-sign
// this binary during bundling, but codesign preserves the entitlements blob
// unless --entitlements is passed again with a different plist.
function signSidecarWithEntitlements(path) {
	const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
	if (!identity) {
		console.log(
			"[prepare-sidecar] APPLE_SIGNING_IDENTITY unset — skipping sidecar pre-sign (dev / unsigned build)",
		);
		return;
	}
	if (!existsSync(entitlementsPlist)) {
		throw new Error(
			`[prepare-sidecar] Entitlements.plist missing at ${entitlementsPlist}`,
		);
	}
	console.log(`[prepare-sidecar] codesign (+entitlements) ${path}`);
	execFileSync(
		"codesign",
		[
			"--force",
			"--sign",
			identity,
			"--timestamp",
			"--options",
			"runtime",
			"--entitlements",
			entitlementsPlist,
			path,
		],
		{ stdio: "inherit" },
	);
}

function detectTargetTriple() {
	return resolveTargetTriple({
		env: process.env,
		readHostTriple: () =>
			execSync("rustc --print host-tuple", { encoding: "utf8" }),
	});
}

function main() {
	// 1. Install sidecar deps (idempotent; fast when lockfile matches).
	run("bun install --frozen-lockfile", sidecarDir);

	// 2. Build the compiled sidecar + staged vendor tree.
	run("bun run build", sidecarDir);

	const triple = detectTargetTriple();
	const artifacts = resolveBundleArtifacts({
		repoRoot,
		targetTriple: triple,
		profile: "release",
		platform: process.platform,
	});

	if (!existsSync(artifacts.sidecarSource)) {
		throw new Error(
			`[prepare-sidecar] expected compiled sidecar at ${artifacts.sidecarSource} but it does not exist`,
		);
	}

	// Tauri validates every `externalBin` during `cargo build`, including the
	// sidecar companion. Stage the target-suffixed sidecar first so a clean CI
	// checkout can compile `helmor-cli` without depending on stale artifacts.
	copyFileSync(artifacts.sidecarSource, artifacts.sidecarExternalBin);

	run(
		`cargo build --manifest-path ${resolve(srcTauriDir, "Cargo.toml")} --bin helmor-cli --release --target ${triple}`,
		repoRoot,
	);

	mkdirSync(dirname(artifacts.cliExternalBin), { recursive: true });

	if (!existsSync(artifacts.cliSource)) {
		throw new Error(
			`[prepare-sidecar] expected compiled CLI at ${artifacts.cliSource} but it does not exist`,
		);
	}

	copyFileSync(artifacts.cliSource, artifacts.cliExternalBin);

	// Sign the target-suffixed copy (the one Tauri ingests as externalBin).
	// No-op when APPLE_SIGNING_IDENTITY is unset.
	signSidecarWithEntitlements(artifacts.sidecarExternalBin);

	console.log(
		`[prepare-sidecar] staged sidecar → ${artifacts.sidecarExternalBin}`,
	);
	console.log(`[prepare-sidecar] staged CLI → ${artifacts.cliExternalBin}`);
}

main();
