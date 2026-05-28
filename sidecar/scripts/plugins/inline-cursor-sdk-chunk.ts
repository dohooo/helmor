// Bun build plugin: inline @cursor/sdk's lazy webpack chunk into the SDK's
// entry module, so `bun build --compile` doesn't have to resolve the chunk
// through a runtime dynamic import (which fails inside the compiled binary
// because webpack's `import("./642.index.js")` is resolved relative to the
// binary entry, not the SDK module location).
//
// Strategy: import chunk 642 statically, then call webpack's `installChunk`
// right after it's defined so `installedChunks[642]` is set to 0 (loaded)
// before any caller can trigger the dynamic-import path.
//
// If @cursor/sdk's webpack runtime layout changes, the build fails loudly
// at the anchor check below — that's intentional, so we catch it during
// release builds rather than at runtime in users' compiled binaries.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";

const ANCHOR = "installedChunks[n[i]]=0},__webpack_require__.f.j=";
const REPLACEMENT =
	"installedChunks[n[i]]=0},installChunk(__chunk_642__),__webpack_require__.f.j=";

export const inlineCursorSdkChunk: BunPlugin = {
	name: "inline-cursor-sdk-chunk",
	setup(build) {
		build.onLoad(
			{ filter: /[\\/]@cursor[\\/]sdk[\\/]dist[\\/]esm[\\/]index\.js$/ },
			async ({ path }) => {
				const code = await readFile(path, "utf8");
				if (!code.includes(ANCHOR)) {
					throw new Error(
						`[inline-cursor-sdk-chunk] webpack runtime in ${path} does not ` +
							"contain the expected anchor; @cursor/sdk likely upgraded — " +
							"update this plugin's ANCHOR/REPLACEMENT.",
					);
				}
				const chunkPath = join(dirname(path), "642.index.js");
				return {
					contents:
						`import * as __chunk_642__ from ${JSON.stringify(chunkPath)};\n` +
						code.replace(ANCHOR, REPLACEMENT),
					loader: "js",
				};
			},
		);
	},
};
