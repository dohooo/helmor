/**
 * Stage Claude Code + Codex CLI binaries into `sidecar/dist/vendor/` so
 * Tauri can bundle them as `bundle.resources` and ship them inside the
 * `.app` payload — no reliance on system-wide `claude` / `codex` installs.
 *
 * Layout produced (host platform only — cross-building requires re-running
 * `bun install` on the target host first):
 *
 *   dist/vendor/
 *     claude-code/
 *       cli.js
 *       vendor/ripgrep/<arch>/rg
 *       vendor/audio-capture/<arch>/audio-capture.node
 *       vendor/seccomp/<arch>/...           (Linux only)
 *     codex/
 *       codex                               (or codex.exe on Windows)
 *     bun/
 *       bun                                 (or bun.exe on Windows)
 *
 * Invariants:
 *   - `cli.js` needs `vendor/` adjacent (Claude Code resolves its own
 *     ripgrep via `path.join(dirname(cli.js), "vendor", "ripgrep", ...)`).
 *   - Only the host-arch subdirs are copied; multi-platform .app bundles
 *     must be built on each target host separately.
 *   - Re-runnable — wipes `dist/vendor/` before copying.
 *
 * Why bundle bun: the Claude Agent SDK spawns `cli.js` through a JS
 * interpreter (bun/node) resolved off PATH. A Finder-launched `.app`
 * inherits a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that contains
 * neither, so we ship the host's bun and point the SDK's `executable`
 * option at an absolute path inside `Contents/Resources/vendor/bun/`.
 */

import { execSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(SIDECAR_ROOT, "node_modules");
const DIST_VENDOR = join(SIDECAR_ROOT, "dist", "vendor");

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type NodePlatform = "darwin" | "linux" | "win32";
type NodeArch = "arm64" | "x64";

interface TargetInfo {
	/** `@anthropic-ai/claude-code` uses `<arch>-<platform>` naming. */
	ccVendorArch: string;
	/** `@openai/codex-<platform>-<arch>` is the npm optional-dep package. */
	codexPkg: string;
	/** Target triple used as the subdir inside the codex platform package. */
	codexTriple: string;
	/** Executable filename inside the codex package. */
	codexBin: string;
}

function detectTarget(): TargetInfo {
	const platform = process.platform as NodePlatform;
	const arch = process.arch as NodeArch;
	const key = `${platform}/${arch}`;

	switch (key) {
		case "darwin/arm64":
			return {
				ccVendorArch: "arm64-darwin",
				codexPkg: "@openai/codex-darwin-arm64",
				codexTriple: "aarch64-apple-darwin",
				codexBin: "codex",
			};
		case "darwin/x64":
			return {
				ccVendorArch: "x64-darwin",
				codexPkg: "@openai/codex-darwin-x64",
				codexTriple: "x86_64-apple-darwin",
				codexBin: "codex",
			};
		case "linux/arm64":
			return {
				ccVendorArch: "arm64-linux",
				codexPkg: "@openai/codex-linux-arm64",
				codexTriple: "aarch64-unknown-linux-musl",
				codexBin: "codex",
			};
		case "linux/x64":
			return {
				ccVendorArch: "x64-linux",
				codexPkg: "@openai/codex-linux-x64",
				codexTriple: "x86_64-unknown-linux-musl",
				codexBin: "codex",
			};
		case "win32/arm64":
			return {
				ccVendorArch: "arm64-win32",
				codexPkg: "@openai/codex-win32-arm64",
				codexTriple: "aarch64-pc-windows-msvc",
				codexBin: "codex.exe",
			};
		case "win32/x64":
			return {
				ccVendorArch: "x64-win32",
				codexPkg: "@openai/codex-win32-x64",
				codexTriple: "x86_64-pc-windows-msvc",
				codexBin: "codex.exe",
			};
		default:
			throw new Error(`Unsupported host platform/arch: ${key}`);
	}
}

// ---------------------------------------------------------------------------
// Copy helpers
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const target = detectTarget();

console.log(
	`[stage-vendor] host=${process.platform}/${process.arch} ccArch=${target.ccVendorArch} codexPkg=${target.codexPkg}`,
);

// Clean
rmSync(DIST_VENDOR, { recursive: true, force: true });
mkdirSync(DIST_VENDOR, { recursive: true });

// ----- Claude Code -----
const ccSrc = join(NODE_MODULES, "@anthropic-ai/claude-code");
const ccDest = join(DIST_VENDOR, "claude-code");
ensureExists(join(ccSrc, "cli.js"), "@anthropic-ai/claude-code/cli.js");

copyFile(join(ccSrc, "cli.js"), join(ccDest, "cli.js"));

// Host-arch subset of claude-code's vendor dirs. cli.js resolves these
// relative to itself at runtime; any missing subdir just disables that
// particular feature (ripgrep → /search, audio-capture → voice I/O).
const ccVendorSubdirs = ["ripgrep", "audio-capture"] as const;
for (const sub of ccVendorSubdirs) {
	const from = join(ccSrc, "vendor", sub, target.ccVendorArch);
	if (existsSync(from)) {
		copyDir(from, join(ccDest, "vendor", sub, target.ccVendorArch));
	}
}
// seccomp is Linux-only (the binary apply-seccomp filter).
if (process.platform === "linux") {
	const seccompArch = process.arch === "arm64" ? "arm64" : "x64";
	const from = join(ccSrc, "vendor", "seccomp", seccompArch);
	if (existsSync(from)) {
		copyDir(from, join(ccDest, "vendor", "seccomp", seccompArch));
	}
}

// ----- Codex -----
const codexSrc = join(
	NODE_MODULES,
	target.codexPkg,
	"vendor",
	target.codexTriple,
	"codex",
	target.codexBin,
);
ensureExists(codexSrc, `${target.codexPkg} codex binary`);

const codexDest = join(DIST_VENDOR, "codex", target.codexBin);
copyFile(codexSrc, codexDest);
// cpSync preserves mode on POSIX, but be defensive — the SDK just spawns
// the path directly, so it has to be +x.
if (process.platform !== "win32") {
	chmodSync(codexDest, 0o755);
}

// ----- Bun (JS runtime for cli.js) -----
function locateHostBun(): string {
	try {
		const cmd = process.platform === "win32" ? "where bun" : "which bun";
		const raw = execSync(cmd, { encoding: "utf8" }).trim().split("\n")[0] ?? "";
		if (!raw) throw new Error("empty output");
		// Homebrew ships bun as a symlink; resolve to the real ELF/Mach-O.
		return realpathSync(raw);
	} catch {
		throw new Error(
			"[stage-vendor] bun not found on PATH — install Bun (https://bun.sh) on the build host. " +
				"The Claude Agent SDK needs a JS runtime to execute cli.js, and `.app` bundles cannot rely " +
				"on the user's PATH. We ship the host's bun binary inside Helmor.app/Contents/Resources/vendor/bun/.",
		);
	}
}

const bunSrc = locateHostBun();
const bunBin = process.platform === "win32" ? "bun.exe" : "bun";
const bunDest = join(DIST_VENDOR, "bun", bunBin);
copyFile(bunSrc, bunDest);
if (process.platform !== "win32") {
	chmodSync(bunDest, 0o755);
}

// ----- Summary -----
console.log(`[stage-vendor] ✓ staged → ${DIST_VENDOR}`);
console.log(`  claude-code ${humanSize(ccDest)}`);
console.log(`  codex       ${humanSize(join(DIST_VENDOR, "codex"))}`);
console.log(`  bun         ${humanSize(join(DIST_VENDOR, "bun"))}`);
