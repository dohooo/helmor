// Stage claude-code + codex + bun + gh + glab into `sidecar/dist/vendor/`
// for Tauri to ship as bundle resources. macOS host only.
//
// Cross-arch staging: in CI the host is always Apple Silicon (macos-26
// runner), but we publish both aarch64-apple-darwin and x86_64-apple-darwin
// bundles. We honor TAURI_TARGET_TRIPLE so the staged vendor binaries match
// the bundle target — otherwise Intel users get arm64 binaries and
// `gh auth login` fails with "bad CPU type in executable" (#293).

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
//   gh:    github.com/cli/cli/releases/download/v$VER/gh_${VER}_checksums.txt
//   glab:  gitlab.com/gitlab-org/cli/-/releases/v$VER/downloads/checksums.txt
//   bun:   github.com/oven-sh/bun/releases/download/bun-v$VER/SHASUMS256.txt
//   codex: shasum -a 256 of the npm tarball at
//          registry.npmjs.org/@openai/codex/-/codex-$VER-darwin-{arm64,x64}.tgz

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

const BUN_VERSION = "1.3.2";
const BUN_SHA256 = {
	arm64: "d85847982db574518130a45582bcf14d8e2be9610b66cb5046c20348578b0fe2",
	x64: "78d4f0c8637427ac0be55639a697ff6a025e8eb940a6920ca508603c41a5a7b0",
} as const;

// Codex version is whatever sidecar/package.json pulled in. The SHAs below
// must match THAT version — bump them together (or staging cross-arch will
// abort with a clear error).
const CODEX_SHA256: Readonly<Record<string, { arm64: string; x64: string }>> = {
	"0.124.0": {
		arm64: "8221653b5f1592007ff19a756cfd00afaa4005b3e944412a3ca2372d0abb3b5a",
		x64: "eb9c0cf46fc9aa58592cd103f0cbc9535667087eb3369d0b99ae62b49f9133da",
	},
};

// ---------------------------------------------------------------------------
// Target detection — honor TAURI_TARGET_TRIPLE so cross-arch CI stages the
// right binaries. Falls back to the host arch for `bun run dev` / local
// staging where no env var is set.
// ---------------------------------------------------------------------------

type DarwinArch = "arm64" | "x64";

interface TargetInfo {
	arch: DarwinArch;
	/** `@anthropic-ai/claude-code` uses `<arch>-darwin` naming. */
	ccVendorArch: string;
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
	/** `bun` release naming: `aarch64` / `x64`. */
	bunArch: "aarch64" | "x64";
}

function infoForArch(arch: DarwinArch): TargetInfo {
	if (arch === "arm64") {
		return {
			arch,
			ccVendorArch: "arm64-darwin",
			codexPkg: "@openai/codex-darwin-arm64",
			codexTriple: "aarch64-apple-darwin",
			codexNpmSuffix: "darwin-arm64",
			ghArch: "arm64",
			glabArch: "arm64",
			bunArch: "aarch64",
		};
	}
	return {
		arch,
		ccVendorArch: "x64-darwin",
		codexPkg: "@openai/codex-darwin-x64",
		codexTriple: "x86_64-apple-darwin",
		codexNpmSuffix: "darwin-x64",
		ghArch: "amd64",
		glabArch: "amd64",
		bunArch: "x64",
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

function copyDir(src: string, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(src, dest, { recursive: true });
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

// ---------------------------------------------------------------------------
// bun — pinned download from oven-sh/bun releases for the target arch.
// Was previously copied from `which bun`, which silently produced an arm64
// binary for x86_64 builds whenever the runner host was Apple Silicon.
// ---------------------------------------------------------------------------

function stageBunBinary(target: TargetInfo): string {
	ensureCacheDir();
	const slug = `bun-darwin-${target.bunArch}`;
	const archive = join(BUNDLE_CACHE, `${slug}-${BUN_VERSION}.zip`);
	const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${slug}.zip`;
	downloadAndVerify(url, archive, BUN_SHA256[target.arch]);

	const extractDir = join(BUNDLE_CACHE, `bun-${BUN_VERSION}-${target.bunArch}`);
	freshExtractDir(extractDir);
	execFileSync("unzip", ["-q", "-o", archive, "-d", extractDir], {
		stdio: "inherit",
	});

	// Archive layout: `bun-darwin-<arch>/bun`.
	const binSrc = join(extractDir, slug, "bun");
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] bun binary missing after extract: ${binSrc}`,
		);
	}
	const binDest = join(DIST_VENDOR, "bun", "bun");
	copyFile(binSrc, binDest);
	chmodSync(binDest, 0o755);
	maybeSignMacBinary(binDest, true);
	return binDest;
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

function copyCodexBin(src: string): string {
	const dest = join(DIST_VENDOR, "codex", "codex");
	copyFile(src, dest);
	chmodSync(dest, 0o755);
	maybeSignMacBinary(dest, false);
	return dest;
}

function stageCodexBinary(target: TargetInfo): string {
	const installed = join(
		NODE_MODULES,
		target.codexPkg,
		"vendor",
		target.codexTriple,
		"codex",
		"codex",
	);
	if (existsSync(installed)) {
		return copyCodexBin(installed);
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
	const binSrc = join(
		extractDir,
		"package",
		"vendor",
		target.codexTriple,
		"codex",
		"codex",
	);
	if (!existsSync(binSrc)) {
		throw new Error(
			`[stage-vendor] codex binary missing after extract: ${binSrc}`,
		);
	}
	return copyCodexBin(binSrc);
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
const ccSrc = join(NODE_MODULES, "@anthropic-ai/claude-code");
const ccDest = join(DIST_VENDOR, "claude-code");
ensureExists(join(ccSrc, "cli.js"), "@anthropic-ai/claude-code/cli.js");

copyFile(join(ccSrc, "cli.js"), join(ccDest, "cli.js"));

// Target-arch subset of claude-code's vendor dirs. cli.js resolves these
// relative to itself at runtime; any missing subdir just disables that
// particular feature (ripgrep -> /search, audio-capture -> voice I/O).
const ccVendorSubdirs = ["ripgrep", "audio-capture"] as const;
for (const sub of ccVendorSubdirs) {
	const from = join(ccSrc, "vendor", sub, target.ccVendorArch);
	if (existsSync(from)) {
		copyDir(from, join(ccDest, "vendor", sub, target.ccVendorArch));
	}
}

// ----- Codex -----
stageCodexBinary(target);

// ----- Bun -----
stageBunBinary(target);

for (const rel of [
	join(ccDest, "vendor", "ripgrep", target.ccVendorArch, "rg"),
	join(
		ccDest,
		"vendor",
		"audio-capture",
		target.ccVendorArch,
		"audio-capture.node",
	),
]) {
	if (existsSync(rel)) {
		maybeSignMacBinary(rel, false);
	}
}

// ----- gh + glab (forge CLIs) -----
stageGhBinary(target.ghArch);
stageGlabBinary(target.glabArch);

// ----- Summary -----
console.log(`[stage-vendor] ✓ staged → ${DIST_VENDOR}`);
console.log(`  claude-code ${humanSize(ccDest)}`);
console.log(`  codex       ${humanSize(join(DIST_VENDOR, "codex"))}`);
console.log(`  bun         ${humanSize(join(DIST_VENDOR, "bun"))}`);
console.log(`  gh          ${humanSize(join(DIST_VENDOR, "gh"))}`);
console.log(`  glab        ${humanSize(join(DIST_VENDOR, "glab"))}`);
