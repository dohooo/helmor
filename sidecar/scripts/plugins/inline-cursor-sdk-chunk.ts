// Bun build plugin: inline @cursor/sdk's lazy webpack chunks into the SDK's
// entry module, so `bun build --compile` doesn't have to resolve them
// through a runtime dynamic import (which fails inside the compiled binary
// because webpack's `import("./<id>.index.js")` is resolved relative to the
// binary entry, not the SDK module location).
//
// Strategy: statically import every `<id>.index.js` chunk that sits next to
// `index.js`, then call webpack's `installChunk` on each right after it's
// defined — so `installedChunks[id]` is set to 0 (loaded) before any caller
// can trigger the dynamic-import path.
//
// The chunk set is discovered at build time (1.0.18 split the local executor
// into its own chunk `429`, alongside cloud `642` and otel `745`), so a
// future chunk rename won't silently drop coverage. The webpack runtime
// anchor is matched structurally; if its layout changes the build fails
// loudly here rather than at runtime in users' compiled binaries.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";

// Matches the point right after webpack's `installChunk` arrow function is
// defined (and `installedChunks` initialized) but before `.f.j` (the
// dynamic-import chunk loader) is assigned. The loop variable name is
// minifier-dependent (`n[i]` pre-1.0.18, `r[a]` after), so match it loosely.
const ANCHOR_RE =
	/(installedChunks\[\w+\[\w+\]\]=0\},)(__webpack_require__\.f\.j=)/;

export const inlineCursorSdkChunk: BunPlugin = {
	name: "inline-cursor-sdk-chunk",
	setup(build) {
		build.onLoad(
			{ filter: /[\\/]@cursor[\\/]sdk[\\/]dist[\\/]esm[\\/]index\.js$/ },
			async ({ path }) => {
				const code = await readFile(path, "utf8");
				if (!ANCHOR_RE.test(code)) {
					throw new Error(
						`[inline-cursor-sdk-chunk] webpack runtime in ${path} does not ` +
							"contain the expected installChunk anchor; @cursor/sdk likely " +
							"upgraded — update this plugin's ANCHOR_RE.",
					);
				}
				const dir = dirname(path);
				const chunkFiles = (await readdir(dir))
					.filter((f) => /^\d+\.index\.js$/.test(f))
					.sort();
				if (chunkFiles.length === 0) {
					throw new Error(
						"[inline-cursor-sdk-chunk] no lazy chunk files (<id>.index.js) " +
							`found next to ${path}; @cursor/sdk layout changed.`,
					);
				}
				const imports = chunkFiles
					.map(
						(f, i) =>
							`import * as __chunk_${i}__ from ${JSON.stringify(join(dir, f))};`,
					)
					.join("\n");
				const installs = chunkFiles
					.map((_, i) => `installChunk(__chunk_${i}__),`)
					.join("");
				return {
					contents: `${imports}\n${code.replace(ANCHOR_RE, `$1${installs}$2`)}`,
					loader: "js",
				};
			},
		);
	},
};
