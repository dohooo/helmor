// Sidecar bundler. Builds the compiled Bun binary plus the Node cursor worker.
// (A script rather than the `bun build --compile` CLI so the worker build +
// vendor staging can ride along.)

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCursorWorker } from "./build-worker.ts";

const SIDECAR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Main sidecar — compiled Bun binary. No build plugins: Cursor's `@cursor/sdk`
// (and its native sqlite3) now live in the separate Node worker, so the old
// sqlite3 shim + cursor-chunk-inlining hacks are gone.
const result = await Bun.build({
	entrypoints: [join(SIDECAR_ROOT, "src/index.ts")],
	compile: { outfile: join(SIDECAR_ROOT, "dist/helmor-sidecar") },
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
