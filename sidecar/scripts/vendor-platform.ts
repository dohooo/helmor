import { targetTripleFromEnv } from "../../scripts/build-platform.js";

export type DarwinArch = "arm64" | "x64";
export type ReleaseArch = "arm64" | "amd64";

export interface TargetInfo {
	/** Target OS — Windows changes archive formats, `.exe` suffixes, and naming. */
	os: "darwin" | "windows";
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
	/** `opencode-darwin-<arch>` is the npm optional-dep package. */
	opencodePkg: string;
	/** opencode npm tarball suffix: `darwin-arm64` / `darwin-x64`. */
	opencodeNpmSuffix: string;
	/** `gh` release naming: `arm64` / `amd64`. */
	ghArch: ReleaseArch;
	/** `glab` release naming: `arm64` / `amd64`. */
	glabArch: ReleaseArch;
	/** `cloudflared` release naming: `arm64` / `amd64`. */
	cloudflaredArch: ReleaseArch;
}

export interface ArchivePlan {
	slug: string;
	archiveName: string;
	url: string;
	sha256: string;
}

export const GH_VERSION = "2.91.0";
export const GH_SHA256 = {
	arm64: "20446cd714d9fa1b69fbd410deade3731f38fe09a2b980c8488aa388dd320ada",
	amd64: "8806784f93603fe6d3f95c3583a08df38f175df9ebc123dc8b15f919329980e2",
} as const;

export const GLAB_VERSION = "1.93.0";
export const GLAB_SHA256 = {
	arm64: "6d6ffa97d430b5e7ff912e64dbac14703acc57967df654be1950ae71858d5b6f",
	amd64: "79d1a4f933919689c5fb7774feb1dd08f30b9c896dff4283b4a7387689ee0531",
} as const;

export const CLOUDFLARED_VERSION = "2026.5.2";
export const CLOUDFLARED_SHA256 = {
	arm64: "ba94054c9fd4297645093d59d51442e5e546d07bb0516120e694a13d5b216d38",
	amd64: "7240f709506bc2c1eb9da4d89cf2555499c60280ecb854b7d80e8f17d4b7903d",
} as const;

export const CODEX_SHA256: Readonly<
	Record<string, { arm64: string; x64: string }>
> = {
	"0.130.0": {
		arm64: "f6fef2ceee8977079ad3b3296b4c14c2707934e6b4ec1aa1a32d6e512196b12d",
		x64: "21f161ffd79fab88c5bd91e40d14c894fe6d4ad61ea4ebc80d4fcf20130960c2",
	},
	"0.134.0": {
		arm64: "82c8bd152cdfb8175fd03d1d18ac0f8cddce22a7e68164572c107f628b0d8b7c",
		x64: "fd518e72bb6f77d2183799b0be00e77d8cc1b465c06e7e129f69028218259a64",
	},
};

export const CLAUDE_CODE_SHA256: Readonly<
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

export const OPENCODE_SHA256: Readonly<
	Record<string, { arm64: string; x64: string }>
> = {
	"1.16.2": {
		arm64: "2103383d7562c1783cb66d63d31630ff90448d1ade90f8a187778d18c4b9ee5f",
		x64: "1be1b4ff8874f0f0848e88bf4de3943a4fff3a51c8b2a75c910fb7f710e7cd03",
	},
};

export const LLAMA_VERSION = "b9496";
export const LLAMA_SHA256: Readonly<{ arm64: string; x64: string }> = {
	arm64: "f1eff7bb49590d80706b84e82e973a21f0bedb49560fbabfea2654756aa59dca",
	x64: "0b415c8d366eabe9ab69fe7d8e79f29b63cc1baa33714967ca8a0c123ae75797",
};

// Node runtime that runs the cursor worker. Node 24 to match Conductor's
// bundled runtime. sqlite3 (the only native addon) is built as an N-API addon
// (`napi_versions` in its package.json), so the prebuilt `.node` is ABI-stable
// across Node majors and Bun — no Node↔addon ABI pinning needed; verified the
// worker loads it on both Node 22 and 24. Bumping: pull SHA256 from
// https://nodejs.org/dist/v$VER/SHASUMS256.txt and wipe sidecar/.bundle-cache.
export const NODE_VERSION = "24.16.0";
export const NODE_SHA256: Readonly<{
	darwin: Record<DarwinArch, string>;
	windows: Record<DarwinArch, string>;
}> = {
	darwin: {
		arm64: "39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6",
		x64: "298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185",
	},
	windows: {
		arm64: "14834611d4c6b3c06054e7007732b90474c16e0b32f395e05b55a571ef71c6d2",
		x64: "edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56",
	},
} as const;

export function nodeArchivePlan(target: TargetInfo): ArchivePlan {
	const platform = target.os === "windows" ? "win" : "darwin";
	const ext = target.os === "windows" ? "zip" : "tar.gz";
	const slug = `node-v${NODE_VERSION}-${platform}-${target.arch}`;
	return {
		slug,
		archiveName: `${slug}.${ext}`,
		url: `https://nodejs.org/dist/v${NODE_VERSION}/${slug}.${ext}`,
		sha256: NODE_SHA256[target.os][target.arch],
	};
}

const TARGETS: Readonly<Record<DarwinArch, TargetInfo>> = {
	arm64: {
		os: "darwin",
		arch: "arm64",
		claudeCodePkg: "@anthropic-ai/claude-code-darwin-arm64",
		claudeCodeNpmSuffix: "darwin-arm64",
		codexPkg: "@openai/codex-darwin-arm64",
		codexTriple: "aarch64-apple-darwin",
		codexNpmSuffix: "darwin-arm64",
		opencodePkg: "opencode-darwin-arm64",
		opencodeNpmSuffix: "darwin-arm64",
		ghArch: "arm64",
		glabArch: "arm64",
		cloudflaredArch: "arm64",
	},
	x64: {
		os: "darwin",
		arch: "x64",
		claudeCodePkg: "@anthropic-ai/claude-code-darwin-x64",
		claudeCodeNpmSuffix: "darwin-x64",
		codexPkg: "@openai/codex-darwin-x64",
		codexTriple: "x86_64-apple-darwin",
		codexNpmSuffix: "darwin-x64",
		opencodePkg: "opencode-darwin-x64",
		opencodeNpmSuffix: "darwin-x64",
		ghArch: "amd64",
		glabArch: "amd64",
		cloudflaredArch: "amd64",
	},
};

/** Windows x64 target. Only x64 is supported (no ARM64 Windows). Pulls the
 *  platform sub-packages bun already installed into node_modules. */
const WINDOWS_X64_TARGET: TargetInfo = {
	os: "windows",
	arch: "x64",
	claudeCodePkg: "@anthropic-ai/claude-code-win32-x64",
	claudeCodeNpmSuffix: "win32-x64",
	// On Windows the codex binary lives in the platform sub-package, not the
	// umbrella @openai/codex package (whose vendor dir is empty).
	codexPkg: "@openai/codex-win32-x64",
	codexTriple: "x86_64-pc-windows-msvc",
	codexNpmSuffix: "win32-x64",
	opencodePkg: "opencode-windows-x64",
	opencodeNpmSuffix: "windows-x64",
	ghArch: "amd64",
	glabArch: "amd64",
	cloudflaredArch: "amd64",
};

export function targetInfoForArch(arch: DarwinArch): TargetInfo {
	return TARGETS[arch];
}

export function resolveVendorTarget(options?: {
	hostPlatform?: NodeJS.Platform;
	hostArch?: string;
	env?: Record<string, string | undefined>;
}): TargetInfo {
	const hostPlatform = options?.hostPlatform ?? process.platform;

	// Windows: stage the x64 sub-packages bun installed into node_modules. No
	// cross-arch matrix (TAURI_TARGET_TRIPLE is a macOS-CI concern), so the host
	// arch is the target.
	if (hostPlatform === "win32") {
		const hostArch = options?.hostArch ?? process.arch;
		if (hostArch !== "x64") {
			throw new Error(
				`[stage-vendor] unsupported Windows host arch: ${hostArch} (only x64)`,
			);
		}
		return WINDOWS_X64_TARGET;
	}

	if (hostPlatform !== "darwin") {
		throw new Error(
			`[stage-vendor] Helmor only builds on macOS and Windows; host platform is ${hostPlatform}`,
		);
	}

	const triple = targetTripleFromEnv(options?.env ?? process.env);
	if (triple) {
		if (triple === "aarch64-apple-darwin") return targetInfoForArch("arm64");
		if (triple === "x86_64-apple-darwin") return targetInfoForArch("x64");
		throw new Error(
			`[stage-vendor] unsupported TAURI_TARGET_TRIPLE for macOS: ${triple}`,
		);
	}

	const hostArch = options?.hostArch ?? process.arch;
	if (hostArch === "arm64") return targetInfoForArch("arm64");
	if (hostArch === "x64") return targetInfoForArch("x64");
	throw new Error(`[stage-vendor] unsupported macOS host arch: ${hostArch}`);
}

export function ghArchivePlan(target: TargetInfo): ArchivePlan {
	const arch = target.ghArch;
	// gh ships macOS as `gh_<ver>_macOS_<arch>.zip` and Windows as
	// `gh_<ver>_windows_<arch>.zip`; both nest `bin/gh[.exe]`. Windows has no
	// pinned sha256 (soft-verify), so leave it empty.
	if (target.os === "windows") {
		const slug = `gh_${GH_VERSION}_windows_${arch}`;
		return {
			slug,
			archiveName: `${slug}.zip`,
			url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${slug}.zip`,
			sha256: "",
		};
	}
	const slug = `gh_${GH_VERSION}_macOS_${arch}`;
	return {
		slug,
		archiveName: `${slug}.zip`,
		url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${slug}.zip`,
		sha256: GH_SHA256[arch],
	};
}

export function glabArchivePlan(target: TargetInfo): ArchivePlan {
	const arch = target.glabArch;
	// macOS: `glab_<ver>_darwin_<arch>.tar.gz`; Windows: `..._windows_<arch>.zip`.
	if (target.os === "windows") {
		const slug = `glab_${GLAB_VERSION}_windows_${arch}`;
		return {
			slug,
			archiveName: `${slug}.zip`,
			url: `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${slug}.zip`,
			sha256: "",
		};
	}
	const slug = `glab_${GLAB_VERSION}_darwin_${arch}`;
	return {
		slug,
		archiveName: `${slug}.tar.gz`,
		url: `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${slug}.tar.gz`,
		sha256: GLAB_SHA256[arch],
	};
}

export function cloudflaredArchivePlan(target: TargetInfo): ArchivePlan {
	const arch = target.cloudflaredArch;
	// Windows: upstream publishes a bare `cloudflared-windows-<arch>.exe` (no
	// archive). The slug is the bare `.exe` filename; the staging executor
	// downloads it straight to the destination (no extraction).
	if (target.os === "windows") {
		const slug = `cloudflared-windows-${arch}`;
		return {
			slug,
			archiveName: `cloudflared-${CLOUDFLARED_VERSION}-windows-${arch}.exe`,
			url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${slug}.exe`,
			sha256: "",
		};
	}
	const slug = `cloudflared-darwin-${arch}`;
	return {
		slug,
		archiveName: `cloudflared-${CLOUDFLARED_VERSION}-darwin-${arch}.tgz`,
		url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${slug}.tgz`,
		sha256: CLOUDFLARED_SHA256[arch],
	};
}

export function claudeCodeArchivePlan(
	target: TargetInfo,
	version: string,
): ArchivePlan {
	const shaTable = CLAUDE_CODE_SHA256[version];
	if (!shaTable) {
		throw new Error(
			`[stage-vendor] no pinned SHA256 for claude-code ${version} — add it to CLAUDE_CODE_SHA256 in vendor-platform.ts`,
		);
	}
	const slug = `claude-code-${target.claudeCodeNpmSuffix}-${version}`;
	return {
		slug,
		archiveName: `${slug}.tgz`,
		url: `https://registry.npmjs.org/${target.claudeCodePkg}/-/claude-code-${target.claudeCodeNpmSuffix}-${version}.tgz`,
		sha256: shaTable[target.arch],
	};
}

export function codexArchivePlan(
	target: TargetInfo,
	version: string,
): ArchivePlan {
	const shaTable = CODEX_SHA256[version];
	if (!shaTable) {
		throw new Error(
			`[stage-vendor] no pinned SHA256 for codex ${version} — add it to CODEX_SHA256 in vendor-platform.ts`,
		);
	}
	const slug = `codex-${version}-${target.codexNpmSuffix}`;
	return {
		slug,
		archiveName: `${slug}.tgz`,
		url: `https://registry.npmjs.org/@openai/codex/-/${slug}.tgz`,
		sha256: shaTable[target.arch],
	};
}

export function opencodeArchivePlan(
	target: TargetInfo,
	version: string,
): ArchivePlan {
	const shaTable = OPENCODE_SHA256[version];
	if (!shaTable) {
		throw new Error(
			`[stage-vendor] no pinned SHA256 for opencode ${version} — add it to OPENCODE_SHA256 in vendor-platform.ts`,
		);
	}
	const slug = `${target.opencodePkg}-${version}`;
	return {
		slug,
		archiveName: `${slug}.tgz`,
		url: `https://registry.npmjs.org/${target.opencodePkg}/-/opencode-${target.opencodeNpmSuffix}-${version}.tgz`,
		sha256: shaTable[target.arch],
	};
}

export function llamaArchivePlan(target: TargetInfo): ArchivePlan {
	// Windows: upstream ships `llama-<ver>-bin-win-cpu-x64.zip` (server + CLIs +
	// their `.dll`s). No pinned sha256 (soft-verify), so leave it empty.
	if (target.os === "windows") {
		const slug = `llama-${LLAMA_VERSION}-bin-win-cpu-x64`;
		return {
			slug,
			archiveName: `${slug}.zip`,
			url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${slug}.zip`,
			sha256: "",
		};
	}
	const archSlug = target.arch === "arm64" ? "macos-arm64" : "macos-x64";
	const slug = `llama-${LLAMA_VERSION}-bin-${archSlug}`;
	return {
		slug,
		archiveName: `${slug}.tar.gz`,
		url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${slug}.tar.gz`,
		sha256: LLAMA_SHA256[target.arch],
	};
}
