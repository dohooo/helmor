// Stage claude-code + codex + opencode + gh + glab + cloudflared into
// `sidecar/dist/vendor/` for Tauri to ship as bundle resources. macOS host only.
//
// Cross-arch staging: in CI the host is always Apple Silicon (macos-26
// runner), but we publish both aarch64-apple-darwin and x86_64-apple-darwin
// bundles. We honor TAURI_TARGET_TRIPLE so the staged vendor binaries match
// the bundle target — otherwise Intel users get arm64 binaries and
// `gh auth login` fails with "bad CPU type in executable" (#293).
//
// Claude Code and Codex are each shipped as a single self-contained native
// binary, pulled from the platform-specific npm sub-package
// (@anthropic-ai/claude-code-darwin-{arm64,x64}/claude,
//  @openai/codex-darwin-{arm64,x64}/.../codex).

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	claudeCodeArchivePlan,
	cloudflaredArchivePlan,
	codexArchivePlan,
	ghArchivePlan,
	glabArchivePlan,
	llamaArchivePlan,
	opencodeArchivePlan,
	resolveVendorTarget,
	type TargetInfo,
} from "./vendor-platform.ts";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(SIDECAR_ROOT, "node_modules");
const DIST_VENDOR = join(SIDECAR_ROOT, "dist", "vendor");
const BUNDLE_CACHE = join(SIDECAR_ROOT, ".bundle-cache");

// Bumping any version: update SHA256 below + wipe sidecar/.bundle-cache.
//   gh:          github.com/cli/cli/releases/download/v$VER/gh_${VER}_checksums.txt
//   glab:        gitlab.com/gitlab-org/cli/-/releases/v$VER/downloads/checksums.txt
//   codex:       shasum -a 256 of the npm tarball at
//                registry.npmjs.org/@openai/codex/-/codex-$VER-darwin-{arm64,x64}.tgz
//   claude-code: shasum -a 256 of the npm tarballs at
//                registry.npmjs.org/@anthropic-ai/claude-code-darwin-{arm64,x64}/-/claude-code-darwin-{arm64,x64}-$VER.tgz
//   cloudflared: shasum -a 256 of the .tgz at
//                github.com/cloudflare/cloudflared/releases/download/$VER/cloudflared-darwin-{arm64,amd64}.tgz
//   opencode:    shasum -a 256 of the npm tarball at
//                registry.npmjs.org/opencode-darwin-{arm64,x64}/-/opencode-darwin-{arm64,x64}-$VER.tgz

// Version pins, SHA256 tables, target mapping, and archive URL rules live in
// `vendor-platform.ts` so platform-specific build support can grow there
// without changing the staging executor below.

// ---------------------------------------------------------------------------
// Target detection — honor TAURI_TARGET_TRIPLE so cross-arch CI stages the
// right binaries. Falls back to the host arch for `bun run dev` / local
// staging where no env var is set.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Copy + download helpers
// ---------------------------------------------------------------------------

function ensureExists(path: string, label: string): void {
	if (!existsSync(path)) {
		throw new Error(
			`[stage-vendor] expected ${label} at ${path} — run \`bun install\` in sidecar/ first`,
		);
	}
}

function copyFile(src: string, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(src, dest);
}

function humanSize(path: string): string {
	if (!existsSync(path)) return "(missing)";
	let bytes = 0;
	const walk = (p: string): void => {
		const s = statSync(p);
		if (s.isDirectory()) {
			for (const entry of readdirSync(p)) {
				walk(join(p, entry));
			}
		} else if (s.isFile()) {
			bytes += s.size;
		}
	};
	walk(path);
	if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

// Shared entitlements plist — Bun's JSC JIT needs allow-jit +
// allow-unsigned-executable-memory under hardened runtime, otherwise
// spawn fails with "Ran out of executable memory while allocating N bytes".
const ENTITLEMENTS_PLIST = join(
	SIDECAR_ROOT,
	"..",
	"src-tauri",
	"Entitlements.plist",
);

function ensureCacheDir(): void {
	mkdirSync(BUNDLE_CACHE, { recursive: true });
}

function sha256OfFile(path: string): string {
	const out = execFileSync("shasum", ["-a", "256", path], {
		encoding: "utf8",
	});
	const digest = out.split(/\s+/)[0];
	if (!digest) throw new Error(`[stage-vendor] empty shasum for ${path}`);
	return digest;
}

function downloadAndVerify(
	url: string,
	dest: string,
	expectedSha256: string,
): void {
	if (existsSync(dest)) {
		const actual = sha256OfFile(dest);
		if (actual === expectedSha256) return;
		console.warn(
			`[stage-vendor] cached ${dest} has wrong sha256 (got ${actual}); re-downloading`,
		);
		rmSync(dest, { force: true });
	}
	console.log(`[stage-vendor] downloading ${url}`);
	mkdirSync(dirname(dest), { recursive: true });
	execFileSync("curl", ["-fL", "--retry", "3", "-o", dest, url], {
		stdio: "inherit",
	});
	const actual = sha256OfFile(dest);
	if (actual !== expectedSha256) {
		rmSync(dest, { force: true });
		throw new Error(
			`[stage-vendor] sha256 mismatch for ${url}\n  expected: ${expectedSha256}\n  actual:   ${actual}`,
		);
	}
}

// Wipe + recreate so a half-failed previous extract can never poison this run.
function freshExtractDir(path: string): void {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
}

function maybeSignMacBinary(path: string, withEntitlements: boolean): void {
	const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
	if (!identity) return;

	const args = [
		"--force",
		"--sign",
		identity,
		"--timestamp",
		"--options",
		"runtime",
	];
	if (withEntitlements) {
		if (!existsSync(ENTITLEMENTS_PLIST)) {
			throw new Error(
				`[stage-vendor] Entitlements.plist missing at ${ENTITLEMENTS_PLIST}`,
			);
		}
		args.push("--entitlements", ENTITLEMENTS_PLIST);
	}
	args.push(path);

	console.log(
		`[stage-vendor] signing ${path}${withEntitlements ? " (+entitlements)" : ""}`,
	);
	execFileSync("codesign", args, { stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// gh / glab — download from upstream releases for the target arch
// ---------------------------------------------------------------------------

/// Find `bin/<name>` either at the archive root or one wrapper level deep.
function locateExtractedBin(extractDir: string, name: string): string {
	const direct = join(extractDir, "bin", name);
	if (existsSync(direct)) return direct;
	for (const entry of readdirSync(extractDir)) {
		const nested = join(extractDir, entry, "bin", name);
		if (existsSync(nested)) return nested;
	}
	throw new Error(
		`[stage-vendor] could not locate bin/${name} under ${extractDir}`,
	);
}

function stageGhBinary(target: TargetInfo): string {
	ensureCacheDir();
	const plan = ghArchivePlan(target);
	const archive = join(BUNDLE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync("unzip", ["-q", "-o", archive, "-d", extractDir], {
		stdio: "inherit",
	});

	const binSrc = locateExtractedBin(extractDir, "gh");
	const binDest = join(DIST_VENDOR, "gh", "gh");
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, false);
	return binDest;
}

function stageGlabBinary(target: TargetInfo): string {
	ensureCacheDir();
	const plan = glabArchivePlan(target);
	const archive = join(BUNDLE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync("tar", ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	const binSrc = join(extractDir, "bin", "glab");
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] glab binary missing after extract: ${binSrc}`,
		);
	}
	const binDest = join(DIST_VENDOR, "glab", "glab");
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, false);
	return binDest;
}

// ---------------------------------------------------------------------------
// cloudflared — mobile-companion tunnel. Single Go binary; the `.tgz` holds
// just `cloudflared` at the archive root. Signed without entitlements (no JIT).
// ---------------------------------------------------------------------------

function stageCloudflaredBinary(target: TargetInfo): string {
	ensureCacheDir();
	const plan = cloudflaredArchivePlan(target);
	const archive = join(BUNDLE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync("tar", ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	const binSrc = join(extractDir, "cloudflared");
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] cloudflared binary missing after extract: ${binSrc}`,
		);
	}
	const binDest = join(DIST_VENDOR, "cloudflared", "cloudflared");
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, false);
	return binDest;
}

// ---------------------------------------------------------------------------
// claude-code — prefer the platform sub-package already on disk; fall back to
// downloading the npm tarball when staging for a non-host architecture.
//
// Source layout: `node_modules/@anthropic-ai/claude-code-darwin-<arch>/claude`
// (single self-contained native binary, ~210 MB; ripgrep + audio-capture +
// JSC runtime are statically embedded).
//
// codesign uses entitlements (allow-jit / allow-unsigned-executable-memory)
// because it's `bun build --compile` output and JSC needs JIT under
// hardened runtime.
// ---------------------------------------------------------------------------

function readClaudeCodeVersion(): string {
	const pkgJsonPath = join(
		NODE_MODULES,
		"@anthropic-ai",
		"claude-code",
		"package.json",
	);
	ensureExists(pkgJsonPath, "@anthropic-ai/claude-code package.json");
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
		version?: string;
	};
	if (!pkg.version) {
		throw new Error(`[stage-vendor] @anthropic-ai/claude-code has no version`);
	}
	return pkg.version;
}

function copyClaudeCodeBin(src: string): string {
	const dest = join(DIST_VENDOR, "claude-code", "claude");
	copyFile(src, dest);
	chmodSync(dest, 0o755);
	maybeSignMacBinary(dest, true);
	return dest;
}

function stageClaudeCodeBinary(target: TargetInfo): string {
	const installed = join(NODE_MODULES, target.claudeCodePkg, "claude");
	if (existsSync(installed)) {
		return copyClaudeCodeBin(installed);
	}

	// Cross-arch: download the platform tarball from npm.
	const version = readClaudeCodeVersion();
	const plan = claudeCodeArchivePlan(target, version);
	ensureCacheDir();
	const archive = join(BUNDLE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync("tar", ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	// npm tarballs nest everything under `package/`.
	const binSrc = join(extractDir, "package", "claude");
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] claude-code binary missing after extract: ${binSrc}`,
		);
	}
	return copyClaudeCodeBin(binSrc);
}

// ---------------------------------------------------------------------------
// codex — prefer the npm package already on disk; fall back to downloading
// the cross-arch tarball from npm when staging for a non-host architecture.
// ---------------------------------------------------------------------------

function readCodexVersion(): string {
	const pkgJsonPath = join(NODE_MODULES, "@openai", "codex", "package.json");
	ensureExists(pkgJsonPath, "@openai/codex package.json");
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
		version?: string;
	};
	if (!pkg.version) {
		throw new Error(`[stage-vendor] @openai/codex has no version field`);
	}
	return pkg.version;
}

/**
 * Stage codex out of `<vendorRoot>/<triple>/`.
 *
 * Source layout (npm tarball or installed package) — read from the
 * `codex-package.json` descriptor when present (see below):
 *   0.134+ (self-describing):  <triple>/bin/codex     — the binary (`entrypoint`)
 *                              <triple>/codex-path/rg  — ripgrep (`pathDir`)
 *   pre-0.134 (legacy):        <triple>/codex/codex    — the binary
 *                              <triple>/path/rg        — ripgrep
 *   (ripgrep is expected on PATH at runtime — codex spawns it for /search)
 *
 * Output:
 *   dist/vendor/codex/codex
 *   dist/vendor/codex/path/rg
 *
 * The sidecar prepends `dist/vendor/codex/path/` to the codex child's PATH
 * env when spawning, so codex finds `rg` without it being globally installed.
 */
function stageCodexFromVendorRoot(archRoot: string): void {
	// codex >= 0.134 ships a self-describing layout descriptor
	// (`codex-package.json` with `entrypoint` + `pathDir`): the binary moved
	// from `codex/codex` to `bin/codex` and ripgrep's dir from `path` to
	// `codex-path`. Read the descriptor when present (forward-compatible) and
	// fall back to the pre-0.134 fixed layout otherwise.
	let entrypoint = "codex/codex";
	let pathDir = "path";
	const descriptor = join(archRoot, "codex-package.json");
	if (existsSync(descriptor)) {
		const meta = JSON.parse(readFileSync(descriptor, "utf8")) as {
			entrypoint?: string;
			pathDir?: string;
		};
		if (meta.entrypoint) entrypoint = meta.entrypoint;
		if (meta.pathDir) pathDir = meta.pathDir;
	}

	const binSrc = join(archRoot, entrypoint);
	if (!existsSync(binSrc)) {
		throw new Error(`[stage-vendor] codex binary missing at ${binSrc}`);
	}
	const binDest = join(DIST_VENDOR, "codex", "codex");
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, false);

	const pathSrc = join(archRoot, pathDir);
	if (existsSync(pathSrc)) {
		const pathDest = join(DIST_VENDOR, "codex", "path");
		cpSync(pathSrc, pathDest, { recursive: true });
		for (const entry of readdirSync(pathDest)) {
			const file = join(pathDest, entry);
			if (statSync(file).isFile()) {
				chmodSync(file, 0o755);
				maybeSignMacBinary(file, false);
			}
		}
	}
}

function stageCodexBinary(target: TargetInfo): void {
	const installedRoot = join(
		NODE_MODULES,
		target.codexPkg,
		"vendor",
		target.codexTriple,
	);
	// New layout (>=0.134): a `codex-package.json` descriptor sits in the
	// vendor root. Legacy layout: a fixed `codex/codex` binary. Either means
	// the platform sub-package is installed for the host arch — use it
	// directly instead of re-downloading the tarball.
	if (
		existsSync(join(installedRoot, "codex-package.json")) ||
		existsSync(join(installedRoot, "codex", "codex"))
	) {
		stageCodexFromVendorRoot(installedRoot);
		return;
	}

	// Cross-arch: download the platform tarball from npm.
	const version = readCodexVersion();
	const plan = codexArchivePlan(target, version);
	ensureCacheDir();
	const archive = join(BUNDLE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync("tar", ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	// npm tarballs nest everything under `package/`.
	const extractedRoot = join(
		extractDir,
		"package",
		"vendor",
		target.codexTriple,
	);
	stageCodexFromVendorRoot(extractedRoot);
}

// ---------------------------------------------------------------------------
// opencode — stage the NATIVE binary `opencode-darwin-<arch>/bin/opencode`,
// NOT the `opencode-ai` Node shim. codesign needs JIT entitlements (true flag).
// ---------------------------------------------------------------------------

function readOpencodeVersion(): string {
	const pkgJsonPath = join(NODE_MODULES, "opencode-ai", "package.json");
	ensureExists(pkgJsonPath, "opencode-ai package.json");
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
		version?: string;
	};
	if (!pkg.version) {
		throw new Error(`[stage-vendor] opencode-ai has no version field`);
	}
	return pkg.version;
}

function copyOpencodeBin(src: string): string {
	const dest = join(DIST_VENDOR, "opencode", "opencode");
	copyFile(src, dest);
	chmodSync(dest, 0o755);
	maybeSignMacBinary(dest, true);
	return dest;
}

function stageOpencodeBinary(target: TargetInfo): string {
	const installed = join(NODE_MODULES, target.opencodePkg, "bin", "opencode");
	if (existsSync(installed)) {
		return copyOpencodeBin(installed);
	}

	// Cross-arch: download the platform tarball from npm.
	const version = readOpencodeVersion();
	const plan = opencodeArchivePlan(target, version);
	ensureCacheDir();
	const archive = join(BUNDLE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync("tar", ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	// npm tarballs nest everything under `package/`.
	const binSrc = join(extractDir, "package", "bin", "opencode");
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] opencode binary missing after extract: ${binSrc}`,
		);
	}
	return copyOpencodeBin(binSrc);
}

// ---------------------------------------------------------------------------
// llama.cpp — download official macOS binary release for the target arch.
// Different from gh/glab: ships as a fat zip containing llama-server +
// llama-cli + a pile of shared libs (libllama, libggml-*, libmtmd, ...).
// We stage the whole bin/ directory as a unit so the dylib RPATHs that
// upstream baked in (`@loader_path/.`) keep resolving.
// ---------------------------------------------------------------------------

/// Soft-verifying download: if `LLAMA_SHA256` for this arch is filled
/// in we treat mismatches as fatal (release-build hardening); when it's
/// empty we print the computed digest and trust HTTPS so dev runs
/// aren't blocked by a missing pinned hash.
function downloadAndVerifyLlama(
	url: string,
	dest: string,
	expectedSha256: string,
): void {
	if (existsSync(dest)) {
		const actual = sha256OfFile(dest);
		if (!expectedSha256 || actual === expectedSha256) return;
		console.warn(
			`[stage-vendor] cached ${dest} has wrong sha256 (got ${actual}); re-downloading`,
		);
		rmSync(dest, { force: true });
	}
	console.log(`[stage-vendor] downloading ${url}`);
	mkdirSync(dirname(dest), { recursive: true });
	execFileSync("curl", ["-fL", "--retry", "3", "-o", dest, url], {
		stdio: "inherit",
	});
	const actual = sha256OfFile(dest);
	if (!expectedSha256) {
		console.warn(
			`[stage-vendor] LLAMA_SHA256 is blank for this arch — got ${actual}. ` +
				"Fill it in to lock the version for CI / release builds.",
		);
		return;
	}
	if (actual !== expectedSha256) {
		rmSync(dest, { force: true });
		throw new Error(
			`[stage-vendor] sha256 mismatch for ${url}\n  expected: ${expectedSha256}\n  actual:   ${actual}`,
		);
	}
}

function stageLlamaCppBinaries(target: TargetInfo): string {
	ensureCacheDir();
	const plan = llamaArchivePlan(target);
	// Upstream ships macOS builds as `.tar.gz` (not `.zip` like the
	// Windows artefacts) — extension matters for both the cache file
	// name and the extract command below.
	const archive = join(BUNDLE_CACHE, plan.archiveName);
	downloadAndVerifyLlama(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync("tar", ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	// The archive nests everything under a single `llama-<ver>/` folder
	// (binaries + dylibs side-by-side, no `bin/`). Earlier upstream
	// shapes used `bin/` or `build/bin/` — probe both so future bumps
	// keep working without script changes.
	const candidates: string[] = [
		...readdirSync(extractDir).flatMap((entry) => [
			join(extractDir, entry),
			join(extractDir, entry, "bin"),
			join(extractDir, entry, "build", "bin"),
		]),
		join(extractDir, "bin"),
		join(extractDir, "build", "bin"),
	];
	const binDir = candidates.find(
		(p) => existsSync(p) && existsSync(join(p, "llama-server")),
	);
	if (!binDir) {
		throw new Error(
			`[stage-vendor] llama-server missing under ${extractDir} — checked ${candidates.join(", ")}`,
		);
	}

	const dest = join(DIST_VENDOR, "llama-cpp");
	freshExtractDir(dest);
	// `cpSync` with `dereference: false` preserves the dylib version
	// symlinks (libggml.dylib → libggml.0.dylib → libggml.0.11.0.dylib).
	// Following them would balloon the bundle ~3× and break the
	// upstream RPATH layout.
	cpSync(binDir, dest, { recursive: true, dereference: false });

	// Upstream tarball is the full llama.cpp toolbox — 25 CLIs + rpc-server
	// + their per-tool `*-impl.dylib`s. We only call `llama-server` at
	// runtime, so prune everything else: smaller bundle and ~10 Mach-O
	// files to sign/notarize instead of ~40.
	//
	// The keep-list is intentionally hard-coded against the llama.cpp pin:
	// if a future bump introduces a new runtime dylib (e.g. a new ggml
	// backend), dev launch of `llama-server` will fail immediately with
	// `dyld: Library not loaded`, which is the cleanest signal to update
	// this list. Closure was confirmed via `otool -L` on llama-server +
	// every first-level dep.
	const keepFiles = new Set(["llama-server", "LICENSE"]);
	const keepDylibStems = new Set([
		"libllama",
		"libllama-common",
		"libllama-server-impl",
		"libmtmd",
		"libggml",
		"libggml-base",
		"libggml-blas",
		"libggml-cpu",
		"libggml-metal",
		"libggml-rpc",
	]);
	// Matches `libfoo.dylib`, `libfoo.0.dylib`, `libfoo.0.12.0.dylib`.
	const dylibRe = /^(lib[a-zA-Z0-9-]+?)(?:\.[\d.]+)?\.dylib$/;
	for (const entry of readdirSync(dest)) {
		if (keepFiles.has(entry)) continue;
		const m = entry.match(dylibRe);
		if (m && keepDylibStems.has(m[1]!)) continue;
		rmSync(join(dest, entry), { force: true, recursive: true });
	}

	// Re-assert exec bit on llama-server — tarball preserves modes
	// already, but cpSync between filesystems sometimes flips them and
	// an un-executable `llama-server` would just fail to spawn with a
	// confusing EACCES.
	chmodSync(join(dest, "llama-server"), 0o755);

	// Sign every Mach-O file. Notarization rejects the bundle if ANY
	// binary inside Resources/ is unsigned, lacks a secure timestamp,
	// or (for executables) doesn't have hardened runtime. `llama-server`
	// needs `allow-jit` / `allow-unsigned-executable-memory` because
	// Metal compute does runtime codegen on Apple Silicon. Dylibs are
	// signed without entitlements (codesign ignores them on libraries).
	// `lstatSync` skips the dylib version symlinks (libfoo.dylib →
	// libfoo.0.dylib → libfoo.0.12.0.dylib) — signing the real file
	// covers all three names.
	for (const entry of readdirSync(dest)) {
		if (entry === "LICENSE") continue;
		const path = join(dest, entry);
		const stat = lstatSync(path);
		if (!stat.isFile()) continue;
		maybeSignMacBinary(path, !entry.endsWith(".dylib"));
	}
	return dest;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const target = resolveVendorTarget();

console.log(
	`[stage-vendor] host=darwin/${process.arch} target=darwin/${target.arch} (${target.codexTriple})`,
);

// Clean
rmSync(DIST_VENDOR, { recursive: true, force: true });
mkdirSync(DIST_VENDOR, { recursive: true });

// ----- Claude Code -----
stageClaudeCodeBinary(target);

// ----- Codex -----
stageCodexBinary(target);

// ----- opencode -----
stageOpencodeBinary(target);

// ----- gh + glab (forge CLIs) -----
stageGhBinary(target);
stageGlabBinary(target);

// ----- cloudflared (mobile-companion tunnel) -----
stageCloudflaredBinary(target);

// ----- llama.cpp (local LLM server for auto-rename / Local AI) -----
stageLlamaCppBinaries(target);

// ----- Summary -----
console.log(`[stage-vendor] ✓ staged → ${DIST_VENDOR}`);
console.log(`  claude-code ${humanSize(join(DIST_VENDOR, "claude-code"))}`);
console.log(`  codex       ${humanSize(join(DIST_VENDOR, "codex"))}`);
console.log(`  opencode    ${humanSize(join(DIST_VENDOR, "opencode"))}`);
console.log(`  gh          ${humanSize(join(DIST_VENDOR, "gh"))}`);
console.log(`  glab        ${humanSize(join(DIST_VENDOR, "glab"))}`);
console.log(`  cloudflared ${humanSize(join(DIST_VENDOR, "cloudflared"))}`);
console.log(`  llama-cpp   ${humanSize(join(DIST_VENDOR, "llama-cpp"))}`);
