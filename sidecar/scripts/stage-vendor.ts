// Stage claude-code + codex + gh + glab + tea into `sidecar/dist/vendor/`
// for Tauri to ship as bundle resources. macOS host only.
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

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(SIDECAR_ROOT, "node_modules");
const DIST_VENDOR = join(SIDECAR_ROOT, "dist", "vendor");
const BUNDLE_CACHE = join(SIDECAR_ROOT, ".bundle-cache");

// Bumping any version: update SHA256 below + wipe sidecar/.bundle-cache.
//   gh:          github.com/cli/cli/releases/download/v$VER/gh_${VER}_checksums.txt
//   glab:        gitlab.com/gitlab-org/cli/-/releases/v$VER/downloads/checksums.txt
//   tea:         gitea.com/gitea/tea/releases/download/v$VER/checksums.txt
//   codex:       shasum -a 256 of the npm tarball at
//                registry.npmjs.org/@openai/codex/-/codex-$VER-darwin-{arm64,x64}.tgz
//   claude-code: shasum -a 256 of the npm tarballs at
//                registry.npmjs.org/@anthropic-ai/claude-code-darwin-{arm64,x64}/-/claude-code-darwin-{arm64,x64}-$VER.tgz

const GH_VERSION = "2.91.0";
const GH_SHA256 = {
	arm64: "20446cd714d9fa1b69fbd410deade3731f38fe09a2b980c8488aa388dd320ada",
	amd64: "8806784f93603fe6d3f95c3583a08df38f175df9ebc123dc8b15f919329980e2",
} as const;

const GLAB_VERSION = "1.93.0";
const GLAB_SHA256 = {
	arm64: "6d6ffa97d430b5e7ff912e64dbac14703acc57967df654be1950ae71858d5b6f",
	amd64: "79d1a4f933919689c5fb7774feb1dd08f30b9c896dff4283b4a7387689ee0531",
} as const;

const TEA_VERSION = "0.14.1";
const TEA_SHA256 = {
	arm64: "52c482b964de63977b5a836b4976f0b098a1dfde6486ca7b8d0a6ee29b4f7945",
	amd64: "4b6828c7dec67cfbd4b911e9391fc9e32eddeea693025ee99a20c444c251f53a",
} as const;

// Codex version is whatever sidecar/package.json pulled in. The SHAs below
// must match THAT version — bump them together (or staging cross-arch will
// abort with a clear error).
const CODEX_SHA256: Readonly<Record<string, { arm64: string; x64: string }>> = {
	"0.130.0": {
		arm64: "f6fef2ceee8977079ad3b3296b4c14c2707934e6b4ec1aa1a32d6e512196b12d",
		x64: "21f161ffd79fab88c5bd91e40d14c894fe6d4ad61ea4ebc80d4fcf20130960c2",
	},
	"0.134.0": {
		arm64: "82c8bd152cdfb8175fd03d1d18ac0f8cddce22a7e68164572c107f628b0d8b7c",
		x64: "fd518e72bb6f77d2183799b0be00e77d8cc1b465c06e7e129f69028218259a64",
	},
};

// Same versioning rule as Codex: must match whatever sidecar/package.json
// pulled in (`@anthropic-ai/claude-code`). Cross-arch staging downloads
// straight from the npm registry and verifies against this table.
const CLAUDE_CODE_SHA256: Readonly<
	Record<string, { arm64: string; x64: string }>
> = {
	"2.1.139": {
		arm64: "ed9a4c64c8b5374da8389ff6aa4b58fce7a792f90ef2261a14445d9082a80799",
		x64: "71d18ce1d457f37b427bdcb5933424c83bf22b39b2b7628415028585b832fe6c",
	},
	"2.1.154": {
		arm64: "2394afa765253caaac8cb030c7954650c4052b537aacc664c634d6397bed064a",
		x64: "95643be424f07808e7b67195695191b05d0edc6ad7c3c274424dfb062c875fb5",
	},
};

// llama.cpp bundled binary. Drives `local_llm::Manager` (the
// auto-rename / local-LLM stack). Versions are `b<N>` build tags from
// github.com/ggml-org/llama.cpp/releases. Bumping the version: replace
// LLAMA_VERSION and the matching arm64/x64 sha256 (computed below from
// the upstream zip on first run; see DEV-fallback notes in
// `downloadAndVerifyLlama`). Wipe sidecar/.bundle-cache when bumping
// so the new archive isn't blocked by a wrong-sha cached copy.
const LLAMA_VERSION = "b9294";
// Leave entries blank to skip strict verification during local dev —
// stage-vendor will warn + trust HTTPS, print the computed sha, and
// proceed. Fill these in (and commit) to lock the build in CI.
const LLAMA_SHA256: Readonly<{ arm64: string; x64: string }> = {
	arm64: "8cb59947211ac84f84a3afe6db83e6b8167ef24e70ca3dde199df48ff6591e44",
	x64: "72ba8001fe1ec75ff6d5fd0fe5be244f25d4c560c2501abbcfcbbfbac6b2d1c1",
};

// ---------------------------------------------------------------------------
// Target detection — honor TAURI_TARGET_TRIPLE so cross-arch CI stages the
// right binaries. Falls back to the host arch for `bun run dev` / local
// staging where no env var is set.
// ---------------------------------------------------------------------------

type DarwinArch = "arm64" | "x64";

interface TargetInfo {
	arch: DarwinArch;
	/** `@anthropic-ai/claude-code-darwin-<arch>` is the platform sub-package. */
	claudeCodePkg: string;
	/** claude-code npm tarball suffix: `darwin-arm64` / `darwin-x64`. */
	claudeCodeNpmSuffix: string;
	/** `@openai/codex-darwin-<arch>` is the npm optional-dep package. */
	codexPkg: string;
	/** Target triple inside the codex platform package. */
	codexTriple: string;
	/** Codex npm tarball suffix: `darwin-arm64` / `darwin-x64`. */
	codexNpmSuffix: string;
	/** `gh` release naming: `arm64` / `amd64`. */
	ghArch: "arm64" | "amd64";
	/** `glab` release naming: `arm64` / `amd64`. */
	glabArch: "arm64" | "amd64";
	/** `tea` release naming: `arm64` / `amd64`. */
	teaArch: "arm64" | "amd64";
}

function infoForArch(arch: DarwinArch): TargetInfo {
	if (arch === "arm64") {
		return {
			arch,
			claudeCodePkg: "@anthropic-ai/claude-code-darwin-arm64",
			claudeCodeNpmSuffix: "darwin-arm64",
			codexPkg: "@openai/codex-darwin-arm64",
			codexTriple: "aarch64-apple-darwin",
			codexNpmSuffix: "darwin-arm64",
			ghArch: "arm64",
			glabArch: "arm64",
			teaArch: "arm64",
		};
	}
	return {
		arch,
		claudeCodePkg: "@anthropic-ai/claude-code-darwin-x64",
		claudeCodeNpmSuffix: "darwin-x64",
		codexPkg: "@openai/codex-darwin-x64",
		codexTriple: "x86_64-apple-darwin",
		codexNpmSuffix: "darwin-x64",
		ghArch: "amd64",
		glabArch: "amd64",
		teaArch: "amd64",
	};
}

function detectTarget(): TargetInfo {
	if (process.platform !== "darwin") {
		throw new Error(
			`[stage-vendor] Helmor only builds on macOS; host platform is ${process.platform}`,
		);
	}

	// Read env in the same order prepare-sidecar.mjs does so they stay in sync.
	const triple =
		process.env.TAURI_TARGET_TRIPLE?.trim() ||
		process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
		process.env.CARGO_BUILD_TARGET?.trim();

	if (triple) {
		if (triple === "aarch64-apple-darwin") return infoForArch("arm64");
		if (triple === "x86_64-apple-darwin") return infoForArch("x64");
		throw new Error(
			`[stage-vendor] unsupported TAURI_TARGET_TRIPLE for macOS: ${triple}`,
		);
	}

	const arch = process.arch;
	if (arch === "arm64") return infoForArch("arm64");
	if (arch === "x64") return infoForArch("x64");
	throw new Error(`[stage-vendor] unsupported macOS host arch: ${arch}`);
}

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

function stageGhBinary(arch: "arm64" | "amd64"): string {
	ensureCacheDir();
	const slug = `gh_${GH_VERSION}_macOS_${arch}`;
	const archive = join(BUNDLE_CACHE, `${slug}.zip`);
	const url = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${slug}.zip`;
	downloadAndVerify(url, archive, GH_SHA256[arch]);

	const extractDir = join(BUNDLE_CACHE, slug);
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

function stageGlabBinary(arch: "arm64" | "amd64"): string {
	ensureCacheDir();
	const slug = `glab_${GLAB_VERSION}_darwin_${arch}`;
	const archive = join(BUNDLE_CACHE, `${slug}.tar.gz`);
	const url = `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${slug}.tar.gz`;
	downloadAndVerify(url, archive, GLAB_SHA256[arch]);

	const extractDir = join(BUNDLE_CACHE, slug);
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

function stageTeaBinary(arch: "arm64" | "amd64"): string {
	ensureCacheDir();
	const slug = `tea-${TEA_VERSION}-darwin-${arch}`;
	const archive = join(BUNDLE_CACHE, slug);
	const url = `https://gitea.com/gitea/tea/releases/download/v${TEA_VERSION}/${slug}`;
	downloadAndVerify(url, archive, TEA_SHA256[arch]);

	const binDest = join(DIST_VENDOR, "tea", "tea");
	copyFile(archive, binDest);
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
	const shaTable = CLAUDE_CODE_SHA256[version];
	if (!shaTable) {
		throw new Error(
			`[stage-vendor] no pinned SHA256 for claude-code ${version} — add it to CLAUDE_CODE_SHA256 in stage-vendor.ts`,
		);
	}
	ensureCacheDir();
	const slug = `claude-code-${target.claudeCodeNpmSuffix}-${version}`;
	const archive = join(BUNDLE_CACHE, `${slug}.tgz`);
	const url = `https://registry.npmjs.org/${target.claudeCodePkg}/-/claude-code-${target.claudeCodeNpmSuffix}-${version}.tgz`;
	downloadAndVerify(url, archive, shaTable[target.arch]);

	const extractDir = join(BUNDLE_CACHE, slug);
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
	const shaTable = CODEX_SHA256[version];
	if (!shaTable) {
		throw new Error(
			`[stage-vendor] no pinned SHA256 for codex ${version} — add it to CODEX_SHA256 in stage-vendor.ts`,
		);
	}
	ensureCacheDir();
	const slug = `codex-${version}-${target.codexNpmSuffix}`;
	const archive = join(BUNDLE_CACHE, `${slug}.tgz`);
	const url = `https://registry.npmjs.org/@openai/codex/-/${slug}.tgz`;
	downloadAndVerify(url, archive, shaTable[target.arch]);

	const extractDir = join(BUNDLE_CACHE, slug);
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
	const archSlug = target.arch === "arm64" ? "macos-arm64" : "macos-x64";
	const slug = `llama-${LLAMA_VERSION}-bin-${archSlug}`;
	// Upstream ships macOS builds as `.tar.gz` (not `.zip` like the
	// Windows artefacts) — extension matters for both the cache file
	// name and the extract command below.
	const archive = join(BUNDLE_CACHE, `${slug}.tar.gz`);
	const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${slug}.tar.gz`;
	downloadAndVerifyLlama(url, archive, LLAMA_SHA256[target.arch]);

	const extractDir = join(BUNDLE_CACHE, slug);
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
	// The keep-list is intentionally hard-coded against LLAMA_VERSION:
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

const target = detectTarget();

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

// ----- gh + glab + tea (forge CLIs) -----
stageGhBinary(target.ghArch);
stageGlabBinary(target.glabArch);
stageTeaBinary(target.teaArch);

// ----- llama.cpp (local LLM server for auto-rename / Local AI) -----
stageLlamaCppBinaries(target);

// ----- Summary -----
console.log(`[stage-vendor] ✓ staged → ${DIST_VENDOR}`);
console.log(`  claude-code ${humanSize(join(DIST_VENDOR, "claude-code"))}`);
console.log(`  codex       ${humanSize(join(DIST_VENDOR, "codex"))}`);
console.log(`  gh          ${humanSize(join(DIST_VENDOR, "gh"))}`);
console.log(`  glab        ${humanSize(join(DIST_VENDOR, "glab"))}`);
console.log(`  llama-cpp   ${humanSize(join(DIST_VENDOR, "llama-cpp"))}`);
console.log(`  tea         ${humanSize(join(DIST_VENDOR, "tea"))}`);
