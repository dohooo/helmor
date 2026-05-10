// Replace `sqlite3`'s package main with a bun:sqlite-backed shim. The native
// sqlite3 addon (`.node` binding) cannot load from inside `bun build --compile`
// output's virtual FS, so the shim substitutes a pure-JS implementation that
// preserves node-sqlite3's variadic callback contract.
//
// We hook onLoad rather than onResolve because Bun's runtime resolves bare
// package specifiers ("sqlite3") before plugin onResolve fires; intercepting
// at the file-load stage works in both `bun run` and `bun build --compile`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";

const SHIM_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"sqlite3-bun-shim.mjs",
);
const SHIM_CONTENTS = readFileSync(SHIM_PATH, "utf8");

export const redirectSqlite3: BunPlugin = {
	name: "redirect-sqlite3",
	setup(build) {
		build.onLoad(
			{ filter: /[\\/]node_modules[\\/]sqlite3[\\/]lib[\\/]sqlite3\.js$/ },
			() => ({ contents: SHIM_CONTENTS, loader: "js" }),
		);
	},
};
