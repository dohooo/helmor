// Builds the Cursor Node worker (`src/cursor-worker/worker.ts`) to a plain
// ESM `dist/cursor-worker.mjs` that runs on Node — NOT the Bun-compiled
// sidecar binary. `@cursor/sdk` stays external so it loads from the staged
// `node_modules` at runtime, where its webpack chunks + native rg/cursorsandbox
// resolve the normal way (the reason this fixes Bun's HTTP/2 frame bug).

import { rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildCursorWorker(): Promise<string> {
	const outdir = join(SIDECAR_ROOT, "dist");
	const result = await Bun.build({
		entrypoints: [join(SIDECAR_ROOT, "src/cursor-worker/worker.ts")],
		target: "node",
		format: "esm",
		outdir,
		external: ["@cursor/sdk"],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	// Normalize the emitted name to `cursor-worker.mjs` (Node-unambiguous ESM).
	const produced = result.outputs[0]?.path;
	if (!produced) throw new Error("[build-worker] no output produced");
	const target = join(outdir, "cursor-worker.mjs");
	if (basename(produced) !== "cursor-worker.mjs") {
		await rename(produced, target);
	}
	return target;
}

// Allow running standalone: `bun run scripts/build-worker.ts`.
if (import.meta.main) {
	const out = await buildCursorWorker();
	console.log(`compiled → ${out}`);
}
