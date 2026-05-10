// Sidecar bundler — replaces `bun build --compile` CLI invocation so we can
// register Bun.build plugins (the CLI does not support inline plugin config).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineCursorSdkChunk } from "./plugins/inline-cursor-sdk-chunk.ts";
import { redirectSqlite3 } from "./plugins/redirect-sqlite3.ts";

const SIDECAR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = await Bun.build({
	entrypoints: [join(SIDECAR_ROOT, "src/index.ts")],
	compile: { outfile: join(SIDECAR_ROOT, "dist/helmor-sidecar") },
	plugins: [inlineCursorSdkChunk, redirectSqlite3],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

for (const out of result.outputs) console.log(`compiled → ${out.path}`);
