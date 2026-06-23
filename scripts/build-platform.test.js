import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	MACOS_RELEASE_TARGETS,
	resolveBundleArtifacts,
	resolveTargetTriple,
	targetTripleFromEnv,
} from "./build-platform.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("build platform boundary", () => {
	it("keeps the macOS release matrix explicit", () => {
		expect(MACOS_RELEASE_TARGETS).toEqual([
			{
				os: "macos",
				arch: "arm64",
				targetTriple: "aarch64-apple-darwin",
				tauriArgs: "--target aarch64-apple-darwin",
				updaterPlatformKey: "darwin-aarch64",
			},
			{
				os: "macos",
				arch: "x64",
				targetTriple: "x86_64-apple-darwin",
				tauriArgs: "--target x86_64-apple-darwin",
				updaterPlatformKey: "darwin-x86_64",
			},
		]);
	});

	it("resolves target triples with the current env precedence", () => {
		expect(
			targetTripleFromEnv({
				TAURI_TARGET_TRIPLE: " aarch64-apple-darwin ",
				TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin",
				CARGO_BUILD_TARGET: "ignored",
			}),
		).toBe("aarch64-apple-darwin");
		expect(
			targetTripleFromEnv({
				TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin",
				CARGO_BUILD_TARGET: "ignored",
			}),
		).toBe("x86_64-apple-darwin");
		expect(
			resolveTargetTriple({
				env: {},
				readHostTriple: () => "aarch64-apple-darwin\n",
			}),
		).toBe("aarch64-apple-darwin");
	});

	it("preserves release externalBin artifact paths", () => {
		expect(
			resolveBundleArtifacts({
				repoRoot: "/repo",
				targetTriple: "aarch64-apple-darwin",
				profile: "release",
				platform: "darwin",
			}),
		).toEqual({
			targetTriple: "aarch64-apple-darwin",
			profile: "release",
			sidecarSource: "/repo/sidecar/dist/helmor-sidecar",
			sidecarExternalBin:
				"/repo/sidecar/dist/helmor-sidecar-aarch64-apple-darwin",
			cliSource:
				"/repo/src-tauri/target/aarch64-apple-darwin/release/helmor-cli",
			cliExternalBin:
				"/repo/src-tauri/target/bundled/helmor-cli-aarch64-apple-darwin",
		});
	});

	it("preserves dev CLI staging paths", () => {
		expect(
			resolveBundleArtifacts({
				repoRoot: "/repo",
				targetTriple: "aarch64-apple-darwin",
				profile: "debug",
				platform: "darwin",
			}),
		).toMatchObject({
			cliSource: "/repo/src-tauri/target/debug/helmor-cli",
			cliExternalBin:
				"/repo/src-tauri/target/bundled/helmor-cli-aarch64-apple-darwin",
		});
	});

	it("keeps Tauri bundle, updater, and macOS signing config unchanged", () => {
		const config = JSON.parse(
			readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
		);

		expect(config.build.beforeBuildCommand).toBe(
			"node scripts/prepare-sidecar.mjs && bun run build",
		);
		expect(config.bundle.externalBin).toEqual([
			"../sidecar/dist/helmor-sidecar",
		]);
		expect(config.bundle.resources).toEqual({
			"../sidecar/dist/vendor/": "vendor",
		});
		expect(config.bundle.createUpdaterArtifacts).toBe(true);
		expect(config.bundle.targets).toBe("all");
		expect(config.bundle.macOS).toEqual({
			entitlements: "Entitlements.plist",
		});
		expect(config.plugins.updater).toEqual({
			pubkey:
				"dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM5QkE5MEUwRjc5N0EzQ0QKUldUTm81ZjM0SkM2T2RweXFnOTYvanRkSENTRW9Zc25sMXRmeFlxazN1MFNZdjZPb2crVWNISzMK",
			endpoints: [
				"https://github.com/dohooo/helmor/releases/latest/download/latest.json",
			],
		});
	});
});
