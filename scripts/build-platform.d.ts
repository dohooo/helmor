export type TargetEnv = Record<string, string | undefined>;

export type ReleaseTarget = {
	os: "macos";
	arch: "arm64" | "x64";
	targetTriple: "aarch64-apple-darwin" | "x86_64-apple-darwin";
	tauriArgs: string;
	updaterPlatformKey: "darwin-aarch64" | "darwin-x86_64";
};

export type BundleProfile = "debug" | "release";

export type BundleArtifactPlan = {
	targetTriple: string;
	profile: BundleProfile;
	sidecarSource: string;
	sidecarExternalBin: string;
	cliSource: string;
	cliExternalBin: string;
};

export const TARGET_TRIPLE_ENV_KEYS: readonly string[];
export const MACOS_RELEASE_TARGETS: readonly ReleaseTarget[];
export function targetTripleFromEnv(env?: TargetEnv): string | undefined;
export function resolveTargetTriple(options?: {
	env?: TargetEnv;
	hostTriple?: string;
	readHostTriple?: () => string;
}): string;
export function cliBinaryNameForPlatform(platform?: NodeJS.Platform): string;
export function resolveBundleArtifacts(options: {
	repoRoot: string;
	targetTriple: string;
	profile?: BundleProfile;
	platform?: NodeJS.Platform;
}): BundleArtifactPlan;
