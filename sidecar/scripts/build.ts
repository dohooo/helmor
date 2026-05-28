// Sidecar bundler — replaces `bun build --compile` CLI invocation so we can
// register Bun.build plugins (the CLI does not support inline plugin config).
//
// Builds the host-platform binary at `dist/helmor-sidecar` and (when
// requested via env) cross-compiles a Linux arm64 + amd64 pair so a daemon
// running on a remote container can spawn the same sidecar surface the
// desktop uses locally. The plugins (sqlite3-bun-shim, inline-cursor-sdk-
// chunk) are crucial in cross-compiled binaries too — without them, the
// `bindings` package walks up bun's virtual `/$bunfs/root/...` looking for
// a `node_modules` directory it cannot find, and crashes at module load.
//
// Targets are selected via `HELMOR_SIDECAR_TARGETS` (comma/space separated):
//   host          (default)
//   linux-arm64   bun-linux-arm64 cross-compile → dist/helmor-sidecar-linux-arm64
//   linux-amd64   bun-linux-x64 cross-compile  → dist/helmor-sidecar-linux-x64
//   all           host + both Linux targets

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineCursorSdkChunk } from "./plugins/inline-cursor-sdk-chunk.ts";
import { redirectSqlite3 } from "./plugins/redirect-sqlite3.ts";

const SIDECAR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const requested = (process.env.HELMOR_SIDECAR_TARGETS ?? "host")
	.split(/[\s,]+/)
	.map((t) => t.trim().toLowerCase())
	.filter(Boolean);
const wantAll = requested.includes("all");
const wantHost =
	wantAll || requested.includes("host") || requested.length === 0;
const wantLinuxArm = wantAll || requested.includes("linux-arm64");
const wantLinuxAmd = wantAll || requested.includes("linux-amd64");

type Target = { name: string; outfile: string; compileTarget?: string };
const targets: Target[] = [];
if (wantHost) {
	targets.push({
		name: "host",
		outfile: join(SIDECAR_ROOT, "dist/helmor-sidecar"),
	});
}
if (wantLinuxArm) {
	targets.push({
		name: "linux-arm64",
		outfile: join(SIDECAR_ROOT, "dist/helmor-sidecar-linux-arm64"),
		compileTarget: "bun-linux-arm64",
	});
}
if (wantLinuxAmd) {
	targets.push({
		name: "linux-amd64",
		outfile: join(SIDECAR_ROOT, "dist/helmor-sidecar-linux-x64"),
		compileTarget: "bun-linux-x64",
	});
}

for (const target of targets) {
	const compile: Record<string, unknown> = { outfile: target.outfile };
	if (target.compileTarget) compile.target = target.compileTarget;
	const result = await Bun.build({
		entrypoints: [join(SIDECAR_ROOT, "src/index.ts")],
		// `compile.target` is honored by Bun.build but not yet in the public
		// type — cast through `unknown` rather than relaxing type checks
		// repo-wide.
		compile: compile as unknown as { outfile: string },
		plugins: [inlineCursorSdkChunk, redirectSqlite3],
	});
	if (!result.success) {
		console.error(`[build.ts] target=${target.name} failed`);
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	for (const out of result.outputs) {
		console.log(`compiled (${target.name}) → ${out.path}`);
	}
}
