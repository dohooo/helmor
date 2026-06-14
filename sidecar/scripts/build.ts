// Sidecar bundler. Builds the compiled Bun binary plus the Node cursor worker.
// (A script rather than the `bun build --compile` CLI so the worker build +
// vendor staging can ride along.)

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCursorWorker } from "./build-worker.ts";

const SIDECAR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Cross-compile the sidecar to the release target. Tauri sets the target triple
// on release builds (see scripts/prepare-sidecar.mjs / .github/workflows/publish.yml);
// cargo cross-compiles the Rust side via `--target`, and this Bun binary MUST match.
// Without it, Bun compiles for the runner's host arch — so an x86_64 .app built on
// an arm64 CI runner ships an arm64 sidecar and Intel users hit
// "bad CPU type in executable: …/helmor-sidecar" (#293).
type BunCompileTarget =
	| "bun-darwin-x64"
	| "bun-darwin-arm64"
	| "bun-windows-x64"
	| "bun-windows-arm64"
	| "bun-linux-x64"
	| "bun-linux-arm64";

const TRIPLE_TO_BUN_TARGET: Record<string, BunCompileTarget> = {
	"x86_64-apple-darwin": "bun-darwin-x64",
	"aarch64-apple-darwin": "bun-darwin-arm64",
	"x86_64-pc-windows-msvc": "bun-windows-x64",
	"aarch64-pc-windows-msvc": "bun-windows-arm64",
	"x86_64-unknown-linux-gnu": "bun-linux-x64",
	"aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

const targetTriple = (
	process.env.TAURI_TARGET_TRIPLE ??
	process.env.TAURI_ENV_TARGET_TRIPLE ??
	process.env.CARGO_BUILD_TARGET ??
	""
).trim();

const bunTarget = targetTriple ? TRIPLE_TO_BUN_TARGET[targetTriple] : undefined;
if (targetTriple && !bunTarget) {
	// Fail loud rather than silently ship a host-arch sidecar for an unknown target.
	throw new Error(
		`build.ts: no Bun compile target mapped for triple "${targetTriple}"`,
	);
}
if (bunTarget) {
	console.log(
		`[build] cross-compiling sidecar → ${bunTarget} (${targetTriple})`,
	);
}

// Main sidecar — compiled Bun binary. No build plugins: Cursor's `@cursor/sdk`
// (and its native sqlite3) now live in the separate Node worker, so the old
// sqlite3 shim + cursor-chunk-inlining hacks are gone.
const result = await Bun.build({
	entrypoints: [join(SIDECAR_ROOT, "src/index.ts")],
	compile: {
		// Omit `target` in dev (env unset) so Bun builds for the host, unchanged.
		...(bunTarget ? { target: bunTarget } : {}),
		outfile: join(SIDECAR_ROOT, "dist/helmor-sidecar"),
	},
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

for (const out of result.outputs) console.log(`compiled → ${out.path}`);

// Cursor Node worker — separate ESM bundle run by Node, not the Bun binary.
const worker = await buildCursorWorker();
console.log(`compiled → ${worker}`);

// In a release build, stage-vendor already laid down the worker's node_modules
// under dist/vendor/cursor-worker; drop the freshly-built entry next to them so
// Node resolves @cursor/sdk from the sibling tree at runtime.
const vendorWorkerDir = join(SIDECAR_ROOT, "dist", "vendor", "cursor-worker");
if (existsSync(vendorWorkerDir)) {
	const vendorWorker = join(vendorWorkerDir, "cursor-worker.mjs");
	copyFileSync(worker, vendorWorker);
	console.log(`staged → ${vendorWorker}`);
}
