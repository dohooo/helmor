// Stage claude-code + codex + gh + glab into `sidecar/dist/vendor/`
// for Tauri to ship as bundle resources. macOS + Linux hosts.
//
// Cross-arch staging: in CI the host is always Apple Silicon (macos-26
// runner), but we publish both aarch64-apple-darwin and x86_64-apple-darwin
// bundles. We honor TAURI_TARGET_TRIPLE so the staged vendor binaries match
// the bundle target — otherwise Intel users get arm64 binaries and
// `gh auth login` fails with "bad CPU type in executable" (#293).
//
// Claude Code and Codex are each shipped as a single self-contained native
// binary, pulled from the platform-specific npm sub-package
// (@anthropic-ai/claude-code-{darwin,linux}-{arm64,x64}/claude,
//  @openai/codex-{darwin,linux}-{arm64,x64}/.../codex).

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
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
//   codex:       shasum -a 256 of the npm tarball at
//                registry.npmjs.org/@openai/codex/-/codex-$VER-darwin-{arm64,x64}.tgz
//   claude-code: shasum -a 256 of the npm tarballs at
//                registry.npmjs.org/@anthropic-ai/claude-code-darwin-{arm64,x64}/-/claude-code-darwin-{arm64,x64}-$VER.tgz

const GH_VERSION = "2.91.0";
const GH_SHA256 = {
	arm64: "20446cd714d9fa1b69fbd410deade3731f38fe09a2b980c8488aa388dd320ada",
	amd64: "8806784f93603fe6d3f95c3583a08df38f175df9ebc123dc8b15f919329980e2",
} as const;

// Linux release tarballs for `gh` (separate table because Linux uses .tar.gz,
// macOS uses .zip; SHAs come from the same upstream `gh_${VER}_checksums.txt`).
// To bump: refresh from
//   https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt
// Look for `gh_${VERSION}_linux_amd64.tar.gz` and `_linux_arm64.tar.gz`.
const GH_SHA256_LINUX = {
	arm64: "ccbed39c472d3dc1c501d1e164a9cffd934c5f6fce1012811a1a59d24cb7d7c6",
	amd64: "304a0d2460f4a8847d2f192bad4e2a32cd9420d28716e7ae32198181b65b5f9c",
} as const;

const GLAB_VERSION = "1.93.0";
const GLAB_SHA256 = {
	arm64: "6d6ffa97d430b5e7ff912e64dbac14703acc57967df654be1950ae71858d5b6f",
	amd64: "79d1a4f933919689c5fb7774feb1dd08f30b9c896dff4283b4a7387689ee0531",
} as const;

// Linux glab uses the lowercase `linux` slug
// (glab_${VER}_linux_{amd64,arm64}.tar.gz) — confirmed against the asset
// list returned by GitLab's release API. To bump, fetch each tarball from
//   https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.tar.gz
// and run `sha256sum` on the cached file.
const GLAB_SHA256_LINUX = {
	arm64: "8d336072e190e540c1ecb187c17d039b3ab408cbb6f1b3c843327a77033145d0",
	amd64: "300f3c12bd75f298747364f382f978bbe63809ef660bb2969925f343f9c20ae4",
} as const;

// Codex version is whatever sidecar/package.json pulled in. The SHAs below
// must match THAT version — bump them together (or staging cross-arch will
// abort with a clear error).
//
// `linux` entries are placeholders until we run the first Linux build.
// TODO(linux): compute via `shasum -a 256` (or `sha256sum`) on the cached
//   .tgz at sidecar/.bundle-cache/codex-${version}-linux-{arm64,x64}.tgz.
const CODEX_SHA256: Readonly<
	Record<
		string,
		{
			arm64: string;
			x64: string;
			linux?: { arm64: string; x64: string };
		}
	>
> = {
	"0.130.0": {
		arm64: "f6fef2ceee8977079ad3b3296b4c14c2707934e6b4ec1aa1a32d6e512196b12d",
		x64: "21f161ffd79fab88c5bd91e40d14c894fe6d4ad61ea4ebc80d4fcf20130960c2",
		linux: {
			arm64: "3f217260abe83c6f0fd7a83e056cb453537e435c6754cd335ecd935823d8f3de",
			x64: "91e12a56c49c702c86c5c42811cfa3d515b6d6bc196d70ba9cea25227302aa8f",
		},
	},
};

// Same versioning rule as Codex: must match whatever sidecar/package.json
// pulled in (`@anthropic-ai/claude-code`). Cross-arch staging downloads
// straight from the npm registry and verifies against this table.
//
// TODO(linux): replace placeholders with real digests on first Linux build.
const CLAUDE_CODE_SHA256: Readonly<
	Record<
		string,
		{
			arm64: string;
			x64: string;
			linux?: { arm64: string; x64: string };
		}
	>
> = {
	"2.1.139": {
		arm64: "ed9a4c64c8b5374da8389ff6aa4b58fce7a792f90ef2261a14445d9082a80799",
		x64: "71d18ce1d457f37b427bdcb5933424c83bf22b39b2b7628415028585b832fe6c",
		linux: {
			arm64: "91d54cb3f13f884823f343206ac0de2edcce75ab8958d21460d500e40b692d3c",
			x64: "671e12d58883de4bc6db3654884dcafc74143598da9798f23d6b77c5627b14e5",
		},
	},
};

// ---------------------------------------------------------------------------
// Target detection — honor TAURI_TARGET_TRIPLE so cross-arch CI stages the
// right binaries. Falls back to the host arch for `bun run dev` / local
// staging where no env var is set.
// ---------------------------------------------------------------------------

type SupportedArch = "arm64" | "x64";
type SupportedPlatform = "darwin" | "linux";

interface TargetInfo {
	platform: SupportedPlatform;
	arch: SupportedArch;
	/** `@anthropic-ai/claude-code-<platform>-<arch>` is the platform sub-package. */
	claudeCodePkg: string;
	/** claude-code npm tarball suffix: `darwin-arm64` / `linux-x64` / etc. */
	claudeCodeNpmSuffix: string;
	/** `@openai/codex-<platform>-<arch>` is the npm optional-dep package. */
	codexPkg: string;
	/** Target triple inside the codex platform package. */
	codexTriple: string;
	/** Codex npm tarball suffix: `darwin-arm64` / `linux-x64` / etc. */
	codexNpmSuffix: string;
	/** `gh` release naming: `arm64` / `amd64`. */
	ghArch: "arm64" | "amd64";
	/** `glab` release naming: `arm64` / `amd64`. */
	glabArch: "arm64" | "amd64";
}

function infoForPlatform(
	platform: SupportedPlatform,
	arch: SupportedArch,
): TargetInfo {
	if (platform === "darwin") {
		if (arch === "arm64") {
			return {
				platform,
				arch,
				claudeCodePkg: "@anthropic-ai/claude-code-darwin-arm64",
				claudeCodeNpmSuffix: "darwin-arm64",
				codexPkg: "@openai/codex-darwin-arm64",
				codexTriple: "aarch64-apple-darwin",
				codexNpmSuffix: "darwin-arm64",
				ghArch: "arm64",
				glabArch: "arm64",
			};
		}
		return {
			platform,
			arch,
			claudeCodePkg: "@anthropic-ai/claude-code-darwin-x64",
			claudeCodeNpmSuffix: "darwin-x64",
			codexPkg: "@openai/codex-darwin-x64",
			codexTriple: "x86_64-apple-darwin",
			codexNpmSuffix: "darwin-x64",
			ghArch: "amd64",
			glabArch: "amd64",
		};
	}

	// Linux. Codex publishes its Linux binaries as statically-linked musl,
	// so the npm tarball nests under `vendor/<arch>-unknown-linux-musl/`
	// even when host/target rust toolchain is `*-linux-gnu`.
	if (arch === "arm64") {
		return {
			platform,
			arch,
			claudeCodePkg: "@anthropic-ai/claude-code-linux-arm64",
			claudeCodeNpmSuffix: "linux-arm64",
			codexPkg: "@openai/codex-linux-arm64",
			codexTriple: "aarch64-unknown-linux-musl",
			codexNpmSuffix: "linux-arm64",
			ghArch: "arm64",
			glabArch: "arm64",
		};
	}
	return {
		platform,
		arch,
		claudeCodePkg: "@anthropic-ai/claude-code-linux-x64",
		claudeCodeNpmSuffix: "linux-x64",
		codexPkg: "@openai/codex-linux-x64",
		codexTriple: "x86_64-unknown-linux-musl",
		codexNpmSuffix: "linux-x64",
		ghArch: "amd64",
		glabArch: "amd64",
	};
}

function detectTarget(): TargetInfo {
	const hostPlatform = process.platform;
	if (hostPlatform !== "darwin" && hostPlatform !== "linux") {
		throw new Error(
			`[stage-vendor] Helmor only builds on macOS or Linux; host platform is ${hostPlatform}`,
		);
	}

	// Read env in the same order prepare-sidecar.mjs does so they stay in sync.
	const triple =
		process.env.TAURI_TARGET_TRIPLE?.trim() ||
		process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
		process.env.CARGO_BUILD_TARGET?.trim();

	if (triple) {
		if (triple === "aarch64-apple-darwin")
			return infoForPlatform("darwin", "arm64");
		if (triple === "x86_64-apple-darwin")
			return infoForPlatform("darwin", "x64");
		if (triple === "x86_64-unknown-linux-gnu")
			return infoForPlatform("linux", "x64");
		if (triple === "aarch64-unknown-linux-gnu")
			return infoForPlatform("linux", "arm64");
		throw new Error(
			`[stage-vendor] unsupported TAURI_TARGET_TRIPLE: ${triple}`,
		);
	}

	const arch = process.arch;
	if (arch !== "arm64" && arch !== "x64") {
		throw new Error(
			`[stage-vendor] unsupported host arch on ${hostPlatform}: ${arch}`,
		);
	}
	return infoForPlatform(hostPlatform, arch);
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
	// macOS ships `shasum`; most Linux distros only ship `sha256sum`. Both
	// emit `<digest>  <path>` so the parsing is identical.
	const useSha256sum = process.platform === "linux";
	const out = useSha256sum
		? execFileSync("sha256sum", [path], { encoding: "utf8" })
		: execFileSync("shasum", ["-a", "256", path], { encoding: "utf8" });
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
	// codesign is macOS-only; on any other host this is a no-op even if the
	// caller forgets to gate it.
	if (process.platform !== "darwin") return;
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
	const arch = target.ghArch;
	if (target.platform === "linux") {
		// Linux releases are tar.gz, named `gh_${VER}_linux_{amd64,arm64}.tar.gz`.
		const slug = `gh_${GH_VERSION}_linux_${arch}`;
		const archive = join(BUNDLE_CACHE, `${slug}.tar.gz`);
		const url = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${slug}.tar.gz`;
		downloadAndVerify(url, archive, GH_SHA256_LINUX[arch]);

		const extractDir = join(BUNDLE_CACHE, slug);
		freshExtractDir(extractDir);
		execFileSync("tar", ["-xzf", archive, "-C", extractDir], {
			stdio: "inherit",
		});

		const binSrc = locateExtractedBin(extractDir, "gh");
		const binDest = join(DIST_VENDOR, "gh", "gh");
		copyFile(binSrc, binDest);
		chmodSync(binDest, 0o755);
		return binDest;
	}

	// macOS releases are .zip with the slug `gh_${VER}_macOS_{arm64,amd64}`.
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

function stageGlabBinary(target: TargetInfo): string {
	ensureCacheDir();
	const arch = target.glabArch;
	// glab uses lowercase OS slugs (`linux`/`darwin`) — confirmed against the
	// asset list returned by GitLab's release API. Same archive shape
	// (tar.gz with bin/glab inside) on both.
	const osSlug = target.platform === "linux" ? "linux" : "darwin";
	const slug = `glab_${GLAB_VERSION}_${osSlug}_${arch}`;
	const archive = join(BUNDLE_CACHE, `${slug}.tar.gz`);
	const url = `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${slug}.tar.gz`;
	const sha =
		target.platform === "linux" ? GLAB_SHA256_LINUX[arch] : GLAB_SHA256[arch];
	downloadAndVerify(url, archive, sha);

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
	const expectedSha =
		target.platform === "linux"
			? shaTable.linux?.[target.arch]
			: shaTable[target.arch];
	if (!expectedSha) {
		throw new Error(
			`[stage-vendor] no pinned SHA256 for claude-code ${version} on ${target.platform}/${target.arch} — add it to CLAUDE_CODE_SHA256`,
		);
	}
	ensureCacheDir();
	const slug = `claude-code-${target.claudeCodeNpmSuffix}-${version}`;
	const archive = join(BUNDLE_CACHE, `${slug}.tgz`);
	const url = `https://registry.npmjs.org/${target.claudeCodePkg}/-/claude-code-${target.claudeCodeNpmSuffix}-${version}.tgz`;
	downloadAndVerify(url, archive, expectedSha);

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
 * Source layout (npm tarball or installed package):
 *   <triple>/codex/codex      — the binary
 *   <triple>/path/rg          — ripgrep, expected on PATH at runtime
 *                                (codex spawns it for /search)
 *
 * Output:
 *   dist/vendor/codex/codex
 *   dist/vendor/codex/path/rg
 *
 * The sidecar prepends `dist/vendor/codex/path/` to the codex child's PATH
 * env when spawning, so codex finds `rg` without it being globally installed.
 */
function stageCodexFromVendorRoot(archRoot: string): void {
	const binSrc = join(archRoot, "codex", "codex");
	if (!existsSync(binSrc)) {
		throw new Error(`[stage-vendor] codex binary missing at ${binSrc}`);
	}
	const binDest = join(DIST_VENDOR, "codex", "codex");
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, false);

	const pathSrc = join(archRoot, "path");
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
	if (existsSync(join(installedRoot, "codex", "codex"))) {
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
	const expectedSha =
		target.platform === "linux"
			? shaTable.linux?.[target.arch]
			: shaTable[target.arch];
	if (!expectedSha) {
		throw new Error(
			`[stage-vendor] no pinned SHA256 for codex ${version} on ${target.platform}/${target.arch} — add it to CODEX_SHA256`,
		);
	}
	ensureCacheDir();
	const slug = `codex-${version}-${target.codexNpmSuffix}`;
	const archive = join(BUNDLE_CACHE, `${slug}.tgz`);
	const url = `https://registry.npmjs.org/@openai/codex/-/${slug}.tgz`;
	downloadAndVerify(url, archive, expectedSha);

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
// Main
// ---------------------------------------------------------------------------

const target = detectTarget();

console.log(
	`[stage-vendor] host=${process.platform}/${process.arch} target=${target.platform}/${target.arch} (${target.codexTriple})`,
);

// Clean
rmSync(DIST_VENDOR, { recursive: true, force: true });
mkdirSync(DIST_VENDOR, { recursive: true });

// ----- Claude Code -----
stageClaudeCodeBinary(target);

// ----- Codex -----
stageCodexBinary(target);

// ----- gh + glab (forge CLIs) -----
stageGhBinary(target);
stageGlabBinary(target);

// ----- Summary -----
console.log(`[stage-vendor] ✓ staged → ${DIST_VENDOR}`);
console.log(`  claude-code ${humanSize(join(DIST_VENDOR, "claude-code"))}`);
console.log(`  codex       ${humanSize(join(DIST_VENDOR, "codex"))}`);
console.log(`  gh          ${humanSize(join(DIST_VENDOR, "gh"))}`);
console.log(`  glab        ${humanSize(join(DIST_VENDOR, "glab"))}`);
