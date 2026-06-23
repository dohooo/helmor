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
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	claudeCodeArchivePlan,
	cloudflaredArchivePlan,
	codexArchivePlan,
	type DarwinArch,
	ghArchivePlan,
	glabArchivePlan,
	KIMI_VERSION,
	kimiArchivePlan,
	llamaArchivePlan,
	nodeArchivePlan,
	opencodeArchivePlan,
	resolveVendorTarget,
	type TargetInfo,
} from "./vendor-platform.ts";

/** Host platform flag: Windows needs `.exe` suffixes, zip extraction via
 *  `tar -xf`, no codesign, and different release/package naming. */
const IS_WINDOWS = process.platform === "win32";
/** Executable suffix for staged binaries on the target. */
const EXE = IS_WINDOWS ? ".exe" : "";
/**
 * Archiver to shell out to. Both bsdtar (Windows 10+ in-box, macOS) handle
 * zip + tar.gz. On Windows we MUST use the System32 bsdtar by absolute path:
 * under a bash shell (CI) a bare `tar` resolves to Git's GNU tar, which reads
 * the `D:` in an archive path like `D:\…\gh.zip` as an `rsh` host spec and
 * fails with "Cannot connect to D: resolve failed". bsdtar treats it as a
 * local path.
 */
const TAR_BIN = IS_WINDOWS
	? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
	: "tar";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(SIDECAR_ROOT, "node_modules");
const DIST_VENDOR = join(SIDECAR_ROOT, "dist", "vendor");

// Local extraction scratch — per-worktree so concurrent `bun run dev` in two
// worktrees can't race `freshExtractDir` on the same slug.
const BUNDLE_CACHE = join(SIDECAR_ROOT, ".bundle-cache");

// Downloaded archives are the network-expensive part and SHA256-verified, so we
// share one cache across all worktrees of this repo: a new worktree reuses
// already-fetched gh/glab/cloudflared/llama-cpp/node archives instead of
// re-downloading them. This is a dev-only optimization, so the cache lives
// inside the PROJECT (the main worktree's `sidecar/.bundle-cache`) rather than a
// global user dir — found via git's common dir, which every linked worktree
// shares. Archive filenames are version-keyed, so different version pins coexist
// safely. Override with HELMOR_BUNDLE_CACHE (CI pins it per-job).
const ARCHIVE_CACHE = resolveArchiveCache();

function resolveArchiveCache(): string {
	const override = process.env.HELMOR_BUNDLE_CACHE?.trim();
	if (override) return resolve(override);
	const mainRoot = mainWorktreeRoot();
	// Fall back to the local scratch dir when not in a git checkout (e.g. a
	// detached tarball build) — degrades to per-worktree, never breaks.
	if (!mainRoot) return BUNDLE_CACHE;
	return join(mainRoot, "sidecar", ".bundle-cache");
}

/// Resolve the main worktree's root via git's common dir. From any linked
/// worktree `git rev-parse --git-common-dir` points at `<mainRoot>/.git`, so its
/// parent is the shared main checkout. Returns null if git is unavailable.
function mainWorktreeRoot(): string | null {
	try {
		const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: SIDECAR_ROOT,
			encoding: "utf8",
		}).trim();
		if (!commonDir) return null;
		return dirname(resolve(SIDECAR_ROOT, commonDir));
	} catch {
		return null;
	}
}

// Bumping any version: update SHA256 below. Archives are version-keyed in the
// shared ARCHIVE_CACHE, so no wipe is needed; a changed SHA256 forces a
// re-download automatically.
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
	mkdirSync(ARCHIVE_CACHE, { recursive: true });
}

function sha256OfFile(path: string): string {
	// Node crypto is cross-platform — avoids depending on a `shasum` binary
	// (absent on Windows).
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/// Extract a `.zip` or `.tar.gz` archive into `destDir`. Uses bsdtar (`tar`),
/// which ships in-box on Windows 10+ and macOS and transparently handles both
/// formats — so we don't need a separate `unzip`.
function extractArchive(archive: string, destDir: string): void {
	execFileSync(TAR_BIN, ["-xf", archive, "-C", destDir], { stdio: "inherit" });
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
	// gh ships macOS as `gh_<ver>_macOS_<arch>.zip` and Windows as
	// `gh_<ver>_windows_<arch>.zip`; both nest `bin/gh[.exe]`. The Windows plan
	// carries no pinned sha256 (soft-verify); macOS stays strict.
	const plan = ghArchivePlan(target);
	const archive = join(ARCHIVE_CACHE, plan.archiveName);
	// downloadMaybeVerify is strict when a sha256 is pinned (macOS) and trusts
	// HTTPS when it's empty (Windows soft-verify).
	downloadMaybeVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	extractArchive(archive, extractDir);

	const binSrc = locateExtractedBin(extractDir, `gh${EXE}`);
	const binDest = join(DIST_VENDOR, "gh", `gh${EXE}`);
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, false);
	return binDest;
}

function stageGlabBinary(target: TargetInfo): string {
	ensureCacheDir();
	// macOS: `glab_<ver>_darwin_<arch>.tar.gz`; Windows: `..._windows_<arch>.zip`.
	// `extractArchive` (bsdtar) transparently handles both formats. Windows plan
	// carries no pinned sha256 (soft-verify); macOS stays strict.
	const plan = glabArchivePlan(target);
	const archive = join(ARCHIVE_CACHE, plan.archiveName);
	downloadMaybeVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	extractArchive(archive, extractDir);

	const binSrc = join(extractDir, "bin", `glab${EXE}`);
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] glab binary missing after extract: ${binSrc}`,
		);
	}
	const binDest = join(DIST_VENDOR, "glab", `glab${EXE}`);
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
	const binDest = join(DIST_VENDOR, "cloudflared", `cloudflared${EXE}`);
	const plan = cloudflaredArchivePlan(target);
	const archive = join(ARCHIVE_CACHE, plan.archiveName);

	// Windows: upstream publishes a bare `cloudflared-windows-<arch>.exe` (no
	// archive), so download it straight to the destination (no extraction).
	// No pinned sha256 (soft-verify).
	if (target.os === "windows") {
		downloadMaybeVerify(plan.url, archive, plan.sha256);
		copyFile(archive, binDest);
		return binDest;
	}

	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync(TAR_BIN, ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	const binSrc = join(extractDir, "cloudflared");
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] cloudflared binary missing after extract: ${binSrc}`,
		);
	}
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
	const dest = join(DIST_VENDOR, "claude-code", `claude${EXE}`);
	copyFile(src, dest);
	chmodSync(dest, 0o755);
	maybeSignMacBinary(dest, true);
	return dest;
}

function stageClaudeCodeBinary(target: TargetInfo): string {
	const installed = join(NODE_MODULES, target.claudeCodePkg, `claude${EXE}`);
	if (existsSync(installed)) {
		return copyClaudeCodeBin(installed);
	}

	// Cross-arch: download the platform tarball from npm.
	const version = readClaudeCodeVersion();
	const plan = claudeCodeArchivePlan(target, version);
	ensureCacheDir();
	const archive = join(ARCHIVE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync(TAR_BIN, ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	// npm tarballs nest everything under `package/`.
	const binSrc = join(extractDir, "package", `claude${EXE}`);
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
	let entrypoint = IS_WINDOWS ? "bin/codex.exe" : "codex/codex";
	let pathDir = "path";
	let resourcesDir: string | undefined;
	const descriptor = join(archRoot, "codex-package.json");
	if (existsSync(descriptor)) {
		const meta = JSON.parse(readFileSync(descriptor, "utf8")) as {
			entrypoint?: string;
			pathDir?: string;
			resourcesDir?: string;
		};
		if (meta.entrypoint) entrypoint = meta.entrypoint;
		if (meta.pathDir) pathDir = meta.pathDir;
		if (meta.resourcesDir) resourcesDir = meta.resourcesDir;
	}

	const binSrc = join(archRoot, entrypoint);
	if (!existsSync(binSrc)) {
		throw new Error(`[stage-vendor] codex binary missing at ${binSrc}`);
	}
	// Flatten the binary to vendor/codex/codex[.exe] — the Rust side resolves it
	// there (see resolve_bundled_agent_paths).
	const binDest = join(DIST_VENDOR, "codex", `codex${EXE}`);
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

	// codex (layoutVersion 1) ships a `codex-resources/` dir that the flattened
	// binary expects adjacent to itself. On macOS it nests a `zsh/bin/zsh`
	// Mach-O; on Windows it carries command-runner + sandbox helpers. Copy it
	// next to codex[.exe] and re-sign every nested Mach-O — notarization rejects
	// any unsigned executable inside the bundle, even several dirs deep.
	if (resourcesDir) {
		const resSrc = join(archRoot, resourcesDir);
		if (existsSync(resSrc)) {
			const resDest = join(DIST_VENDOR, "codex", resourcesDir);
			cpSync(resSrc, resDest, { recursive: true });
			signCodexResourcesTree(resDest);
		}
	}
}

// Walk `codex-resources/` recursively: make every file executable and re-sign
// each Mach-O with our Developer ID + hardened runtime. The tree can nest
// binaries (e.g. `zsh/bin/zsh`), so a flat top-level pass misses them and
// notarization fails.
function signCodexResourcesTree(root: string): void {
	const stack = [root];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (!cur) continue;
		for (const entry of readdirSync(cur)) {
			const p = join(cur, entry);
			const st = lstatSync(p);
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) {
				stack.push(p);
			} else if (st.isFile()) {
				chmodSync(p, 0o755);
				if (isMachO(p)) maybeSignMacBinary(p, false);
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
	const archive = join(ARCHIVE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync(TAR_BIN, ["-xzf", archive, "-C", extractDir], {
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
	const dest = join(DIST_VENDOR, "opencode", `opencode${EXE}`);
	copyFile(src, dest);
	chmodSync(dest, 0o755);
	maybeSignMacBinary(dest, true);
	return dest;
}

function stageOpencodeBinary(target: TargetInfo): string {
	const installed = join(
		NODE_MODULES,
		target.opencodePkg,
		"bin",
		`opencode${EXE}`,
	);
	if (existsSync(installed)) {
		return copyOpencodeBin(installed);
	}

	// Cross-arch: download the platform tarball from npm.
	const version = readOpencodeVersion();
	const plan = opencodeArchivePlan(target, version);
	ensureCacheDir();
	const archive = join(ARCHIVE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync(TAR_BIN, ["-xzf", archive, "-C", extractDir], {
		stdio: "inherit",
	});

	// npm tarballs nest everything under `package/`.
	const binSrc = join(extractDir, "package", "bin", `opencode${EXE}`);
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] opencode binary missing after extract: ${binSrc}`,
		);
	}
	return copyOpencodeBin(binSrc);
}

// ---------------------------------------------------------------------------
// kimi — Kimi Code CLI. Per-platform native binary (Node SEA), shipped as a
// GitHub release `.zip` holding a single `kimi[.exe]` at the archive root.
// codesign needs JIT entitlements (true flag) because V8's JIT hits the same
// hardened-runtime wall as the Bun/Node binaries.
// ---------------------------------------------------------------------------

function stageKimiBinary(target: TargetInfo): string {
	ensureCacheDir();
	const plan = kimiArchivePlan(target, KIMI_VERSION);
	// Shared cross-worktree archive cache (like every other vendor) so a new
	// worktree reuses the downloaded zip (~43 MB) instead of re-fetching it.
	// kimi ships no npm package, so it ALWAYS hits this download path — unlike
	// codex/claude, which come from node_modules on a native-arch host.
	const archive = join(ARCHIVE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	extractArchive(archive, extractDir);

	// The release zip holds a single `kimi[.exe]` at the archive root; tolerate
	// a one-level wrapper dir in case upstream re-nests it.
	let binSrc = join(extractDir, `kimi${EXE}`);
	if (!existsSync(binSrc)) {
		for (const entry of readdirSync(extractDir)) {
			const nested = join(extractDir, entry, `kimi${EXE}`);
			if (existsSync(nested)) {
				binSrc = nested;
				break;
			}
		}
	}
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] kimi binary missing after extract: ${extractDir}`,
		);
	}
	const binDest = join(DIST_VENDOR, "kimi", `kimi${EXE}`);
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, true);
	return binDest;
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
function downloadMaybeVerify(
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
			`[stage-vendor] no pinned sha256 — got ${actual} for ${url}. ` +
				"Pin it to lock the version for CI / release builds.",
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
	const archive = join(ARCHIVE_CACHE, plan.archiveName);

	// Windows: upstream ships `llama-<ver>-bin-win-cpu-x64.zip` (server + CLIs +
	// their `.dll`s, no `bin/` wrapper). Stage the whole tree as a unit (the
	// DLLs must sit beside llama-server.exe) — no dylib pruning/signing dance.
	// No pinned sha256 (soft-verify).
	if (target.os === "windows") {
		downloadMaybeVerify(plan.url, archive, plan.sha256);

		const extractDir = join(BUNDLE_CACHE, plan.slug);
		freshExtractDir(extractDir);
		extractArchive(archive, extractDir);

		const candidates: string[] = [
			extractDir,
			join(extractDir, "build", "bin"),
			...readdirSync(extractDir).flatMap((entry) => [
				join(extractDir, entry),
				join(extractDir, entry, "build", "bin"),
			]),
		];
		const binDir = candidates.find(
			(p) => existsSync(p) && existsSync(join(p, "llama-server.exe")),
		);
		if (!binDir) {
			throw new Error(
				`[stage-vendor] llama-server.exe missing under ${extractDir}`,
			);
		}
		const dest = join(DIST_VENDOR, "llama-cpp");
		freshExtractDir(dest);
		cpSync(binDir, dest, { recursive: true });
		return dest;
	}

	// Upstream ships macOS builds as `.tar.gz` (not `.zip` like the
	// Windows artefacts) — extension matters for both the cache file
	// name and the extract command below. macOS keeps strict sha256 when
	// pinned (soft-verify when the LLAMA_SHA256 entry is blank for dev).
	downloadMaybeVerify(plan.url, archive, plan.sha256);

	const extractDir = join(BUNDLE_CACHE, plan.slug);
	freshExtractDir(extractDir);
	execFileSync(TAR_BIN, ["-xzf", archive, "-C", extractDir], {
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
// Cursor worker — Node runtime + a self-contained @cursor/sdk node_modules.
// Cursor's SDK can't run on Bun (its HTTP/2 client drops tool traffic in git
// repos with NGHTTP2_FRAME_SIZE_ERROR), so it runs in a Node child process.
// The built `cursor-worker.mjs` is copied in by `build.ts`; here we stage the
// dependency tree it loads at runtime (@cursor/sdk + the bundled
// rg/cursorsandbox in @cursor/sdk-<triple>; the SQLite store now uses Node's
// built-in `node:sqlite`).
// ---------------------------------------------------------------------------

// Stage the Node runtime that runs the cursor worker. Release-launched apps
// have no `node` on PATH, so it must ride along in the bundle. Only the single
// `node` binary is copied (not the npm/dist tree).
function stageNodeRuntime(target: TargetInfo): string {
	const plan = nodeArchivePlan(target);
	const dest = join(DIST_VENDOR, "node", `node${EXE}`);
	ensureCacheDir();
	const archive = join(ARCHIVE_CACHE, plan.archiveName);
	downloadAndVerify(plan.url, archive, plan.sha256);
	const extractDir = join(BUNDLE_CACHE, `${plan.slug}-extract`);
	freshExtractDir(extractDir);
	extractArchive(archive, extractDir);
	// Unix tarball → `<slug>/bin/node`; Windows zip → `<slug>/node.exe`.
	const binSrc =
		target.os === "windows"
			? join(extractDir, plan.slug, `node${EXE}`)
			: join(extractDir, plan.slug, "bin", "node");
	ensureExists(binSrc, "extracted node binary");
	copyFile(binSrc, dest);
	chmodSync(dest, 0o755);
	// V8's JIT needs the same allow-jit / allow-unsigned-executable-memory
	// entitlements as the Bun binaries under hardened runtime.
	maybeSignMacBinary(dest, true);
	return dest;
}

function readCursorSdkVersion(): string {
	const pkgJsonPath = join(NODE_MODULES, "@cursor", "sdk", "package.json");
	ensureExists(pkgJsonPath, "@cursor/sdk package.json");
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
		version?: string;
	};
	if (!pkg.version) {
		throw new Error(`[stage-vendor] @cursor/sdk has no version`);
	}
	return pkg.version;
}

function stageCursorWorkerDeps(target: TargetInfo): string {
	const version = readCursorSdkVersion();
	const dest = join(DIST_VENDOR, "cursor-worker");
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	writeFileSync(
		join(dest, "package.json"),
		`${JSON.stringify(
			{
				name: "helmor-cursor-worker",
				private: true,
				dependencies: { "@cursor/sdk": version },
			},
			null,
			2,
		)}\n`,
	);

	// Install for the BUNDLE target, not the build host. The macos-26 runner is
	// arm64 and cross-builds the x86_64 bundle, so a plain `bun install` would
	// drop the arm64 @cursor/sdk-darwin-arm64 (rg/cursorsandbox) into the x64
	// Node bundle and crash Cursor on Intel. `--cpu/--os` (and the npm_config_*
	// mirrors) select the right platform optional-dep for the bundle target.
	const npmOs = target.os === "windows" ? "win32" : "darwin";
	const npmArch = target.arch; // "x64" | "arm64"
	console.log(
		`[stage-vendor] installing @cursor/sdk@${version} for ${npmOs}-${npmArch} (cursor worker)`,
	);
	const installCommand = IS_WINDOWS ? "npm.cmd" : process.execPath;
	execFileSync(
		installCommand,
		["install", `--cpu=${npmArch}`, `--os=${npmOs}`],
		{
			cwd: dest,
			stdio: "inherit",
			env: {
				...process.env,
				npm_config_target_arch: npmArch,
				npm_config_target_platform: npmOs,
				npm_config_arch: npmArch,
				npm_config_platform: npmOs,
			},
		},
	);

	verifyCursorWorkerArch(dest, npmOs, npmArch);
	signCursorWorkerMachOs(dest);
	return dest;
}

/// The staged node_modules ships native Mach-O (rg, cursorsandbox) that arrive
/// ad-hoc/linker-signed. Tauri's signing doesn't reach nested Resources, so
/// re-sign each with our Developer ID + hardened runtime (no entitlements —
/// none of them JIT) or notarization rejects the bundle. No-op when not signing
/// (dev) and skips non-Mach-O (e.g. Windows PE).
function signCursorWorkerMachOs(dest: string): void {
	if (!process.env.APPLE_SIGNING_IDENTITY?.trim()) return;
	const root = join(dest, "node_modules");
	if (!existsSync(root)) return;
	let signed = 0;
	const stack = [root];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (!cur) break;
		for (const entry of readdirSync(cur)) {
			const p = join(cur, entry);
			const st = lstatSync(p);
			if (st.isSymbolicLink()) continue; // .bin/* point inside the tree
			if (st.isDirectory()) {
				stack.push(p);
			} else if (st.isFile() && isMachO(p)) {
				maybeSignMacBinary(p, false);
				signed += 1;
			}
		}
	}
	console.log(`[stage-vendor] cursor worker: signed ${signed} Mach-O file(s)`);
}

function isMachO(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(4);
		if (readSync(fd, buf, 0, 4, 0) < 4) return false;
		const magic = buf.toString("hex");
		// thin Mach-O (LE 64/32, BE 64/32) + fat/universal.
		return (
			magic === "cffaedfe" ||
			magic === "cefaedfe" ||
			magic === "feedfacf" ||
			magic === "feedface" ||
			magic === "cafebabe" ||
			magic === "bebafeca"
		);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/// Fail the build if the staged cursor-worker deps aren't the bundle target's
/// architecture — guards against the cross-arch footgun above.
function verifyCursorWorkerArch(
	dest: string,
	npmOs: string,
	npmArch: DarwinArch,
): void {
	const cursorScope = join(dest, "node_modules", "@cursor");
	const wantPkg = `sdk-${npmOs}-${npmArch}`;
	if (!existsSync(join(cursorScope, wantPkg))) {
		throw new Error(
			`[stage-vendor] cursor worker: platform package @cursor/${wantPkg} not installed — cross-arch resolution failed`,
		);
	}
	// A stray wrong-arch sibling would also get bundled and crash at runtime.
	const stray = readdirSync(cursorScope).filter(
		(n) => /^sdk-(darwin|win32|linux)-/.test(n) && n !== wantPkg,
	);
	if (stray.length > 0) {
		throw new Error(
			`[stage-vendor] cursor worker: unexpected wrong-arch platform package(s): ${stray.join(", ")}`,
		);
	}
	console.log(
		`[stage-vendor] cursor worker deps verified (${npmOs}-${npmArch})`,
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const target = resolveVendorTarget();

console.log(
	`[stage-vendor] host=${process.platform}/${process.arch} target=${target.os}/${target.arch} (${target.codexTriple})`,
);

/// Run an optional stager: on Windows a failure (e.g. an upstream artifact that
/// isn't published for win-x64) is downgraded to a warning so it doesn't abort
/// the whole prepare; on macOS staging stays strict.
function stageOptional(label: string, fn: () => void): void {
	try {
		fn();
	} catch (e) {
		if (IS_WINDOWS) {
			console.warn(
				`[stage-vendor] ${label} not staged on Windows (${(e as Error).message}) — feature falls back to a PATH-installed binary if present`,
			);
		} else {
			throw e;
		}
	}
}

// Clean
rmSync(DIST_VENDOR, { recursive: true, force: true });
mkdirSync(DIST_VENDOR, { recursive: true });

// ----- Claude Code -----
stageClaudeCodeBinary(target);

// ----- Codex -----
stageCodexBinary(target);

// ----- opencode -----
stageOptional("opencode", () => stageOpencodeBinary(target));

// ----- kimi (Kimi Code CLI, ACP provider) -----
stageOptional("kimi", () => stageKimiBinary(target));

// ----- gh + glab (forge CLIs) -----
// Wrapped in stageOptional so a missing/unpublished Windows artifact downgrades
// to a warning; on macOS stageOptional re-throws, keeping staging strict.
stageOptional("gh", () => stageGhBinary(target));
stageOptional("glab", () => stageGlabBinary(target));

// ----- cloudflared (mobile-companion tunnel) -----
stageOptional("cloudflared", () => stageCloudflaredBinary(target));

// ----- llama.cpp (local LLM server for auto-rename / Local AI) -----
stageOptional("llama-cpp", () => stageLlamaCppBinaries(target));

// ----- Cursor worker deps — release builds only (set by the `build` script).
// Dev resolves @cursor/sdk from sidecar/node_modules, so `dev:prepare` skips
// this ~minute-long install. Node runtime is staged separately (see CI). -----
if (process.env.HELMOR_STAGE_CURSOR_WORKER === "1") {
	stageNodeRuntime(target);
	stageCursorWorkerDeps(target);
}

// ----- Summary -----
console.log(`[stage-vendor] ✓ staged → ${DIST_VENDOR}`);
console.log(`  claude-code ${humanSize(join(DIST_VENDOR, "claude-code"))}`);
console.log(`  codex       ${humanSize(join(DIST_VENDOR, "codex"))}`);
console.log(`  opencode    ${humanSize(join(DIST_VENDOR, "opencode"))}`);
console.log(`  kimi        ${humanSize(join(DIST_VENDOR, "kimi"))}`);
console.log(`  gh          ${humanSize(join(DIST_VENDOR, "gh"))}`);
console.log(`  glab        ${humanSize(join(DIST_VENDOR, "glab"))}`);
console.log(`  cloudflared ${humanSize(join(DIST_VENDOR, "cloudflared"))}`);
console.log(`  llama-cpp   ${humanSize(join(DIST_VENDOR, "llama-cpp"))}`);
if (process.env.HELMOR_STAGE_CURSOR_WORKER === "1") {
	console.log(`  node        ${humanSize(join(DIST_VENDOR, "node"))}`);
	console.log(
		`  cursor-worker ${humanSize(join(DIST_VENDOR, "cursor-worker"))}`,
	);
}
