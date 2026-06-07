import { resolve } from "node:path";

export const TARGET_TRIPLE_ENV_KEYS = Object.freeze([
	"TAURI_TARGET_TRIPLE",
	"TAURI_ENV_TARGET_TRIPLE",
	"CARGO_BUILD_TARGET",
]);

export const MACOS_RELEASE_TARGETS = Object.freeze([
	Object.freeze({
		os: "macos",
		arch: "arm64",
		targetTriple: "aarch64-apple-darwin",
		tauriArgs: "--target aarch64-apple-darwin",
		updaterPlatformKey: "darwin-aarch64",
	}),
	Object.freeze({
		os: "macos",
		arch: "x64",
		targetTriple: "x86_64-apple-darwin",
		tauriArgs: "--target x86_64-apple-darwin",
		updaterPlatformKey: "darwin-x86_64",
	}),
]);

export function targetTripleFromEnv(env = process.env) {
	for (const key of TARGET_TRIPLE_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	return undefined;
}

export function resolveTargetTriple(options = {}) {
	const fromEnv = targetTripleFromEnv(options.env ?? process.env);
	if (fromEnv) return fromEnv;

	const hostTriple =
		typeof options.readHostTriple === "function"
			? options.readHostTriple()
			: options.hostTriple;
	const trimmed = hostTriple?.trim();
	if (!trimmed) {
		throw new Error("Unable to resolve target triple");
	}
	return trimmed;
}

export function cliBinaryNameForPlatform(platform = process.platform) {
	return platform === "win32" ? "helmor-cli.exe" : "helmor-cli";
}

export function resolveBundleArtifacts(options) {
	const repoRoot = resolve(options.repoRoot);
	const targetTriple = options.targetTriple;
	const profile = options.profile ?? "release";
	const platform = options.platform ?? process.platform;
	const sidecarDir = resolve(repoRoot, "sidecar");
	const srcTauriDir = resolve(repoRoot, "src-tauri");
	// Bun's `--compile` and cargo both append `.exe` on Windows, and Tauri's
	// `externalBin` resolution expects the `-<triple>` artifacts to carry it too.
	const exe = platform === "win32" ? ".exe" : "";
	const cliBinaryName = cliBinaryNameForPlatform(platform);
	const cliSource =
		profile === "release"
			? resolve(srcTauriDir, "target", targetTriple, "release", cliBinaryName)
			: resolve(srcTauriDir, "target", "debug", cliBinaryName);

	return {
		targetTriple,
		profile,
		sidecarSource: resolve(sidecarDir, "dist", `helmor-sidecar${exe}`),
		sidecarExternalBin: resolve(
			sidecarDir,
			"dist",
			`helmor-sidecar-${targetTriple}${exe}`,
		),
		cliSource,
		cliExternalBin: resolve(
			srcTauriDir,
			"target",
			"bundled",
			`helmor-cli-${targetTriple}${exe}`,
		),
	};
}
