import { describe, expect, test } from "bun:test";
import {
	claudeCodeArchivePlan,
	cloudflaredArchivePlan,
	codexArchivePlan,
	ghArchivePlan,
	glabArchivePlan,
	llamaArchivePlan,
	opencodeArchivePlan,
	resolveVendorTarget,
	targetInfoForArch,
} from "./vendor-platform.ts";

describe("vendor platform boundary", () => {
	test("keeps current macOS target metadata unchanged", () => {
		expect(targetInfoForArch("arm64")).toEqual({
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
		});
		expect(targetInfoForArch("x64")).toEqual({
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
		});
	});

	test("honors target triple overrides before host arch", () => {
		expect(
			resolveVendorTarget({
				hostPlatform: "darwin",
				hostArch: "arm64",
				env: { TAURI_TARGET_TRIPLE: "x86_64-apple-darwin" },
			}),
		).toEqual(targetInfoForArch("x64"));
		expect(
			resolveVendorTarget({
				hostPlatform: "darwin",
				hostArch: "x64",
				env: { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" },
			}),
		).toEqual(targetInfoForArch("arm64"));
	});

	test("keeps non-macOS and unsupported targets out of vendor staging", () => {
		expect(() =>
			resolveVendorTarget({ hostPlatform: "linux", hostArch: "x64", env: {} }),
		).toThrow("Helmor only builds on macOS");
		expect(() =>
			resolveVendorTarget({
				hostPlatform: "darwin",
				hostArch: "arm64",
				env: { TAURI_TARGET_TRIPLE: "x86_64-pc-windows-msvc" },
			}),
		).toThrow("unsupported TAURI_TARGET_TRIPLE for macOS");
	});

	test("resolves Windows x64 to the win32 vendor target", () => {
		const target = resolveVendorTarget({
			hostPlatform: "win32",
			hostArch: "x64",
			env: {},
		});
		expect(target.os).toBe("windows");
		expect(target.arch).toBe("x64");
		expect(target.claudeCodePkg).toBe("@anthropic-ai/claude-code-win32-x64");
		expect(target.codexPkg).toBe("@openai/codex-win32-x64");
		expect(target.codexTriple).toBe("x86_64-pc-windows-msvc");
		expect(target.opencodePkg).toBe("opencode-windows-x64");
		expect(ghArchivePlan(target).archiveName).toBe(
			"gh_2.94.0_windows_amd64.zip",
		);
		expect(glabArchivePlan(target).archiveName).toBe(
			"glab_1.102.0_windows_amd64.zip",
		);
		expect(cloudflaredArchivePlan(target).archiveName).toBe(
			"cloudflared-2026.6.0-windows-amd64.exe",
		);
		expect(llamaArchivePlan(target).archiveName).toBe(
			"llama-b9496-bin-win-cpu-x64.zip",
		);
		expect(() =>
			resolveVendorTarget({
				hostPlatform: "win32",
				hostArch: "arm64",
				env: {},
			}),
		).toThrow("unsupported Windows host arch");
	});

	test("keeps current arm64 vendor archive plans unchanged", () => {
		const target = targetInfoForArch("arm64");
		expect(ghArchivePlan(target)).toEqual({
			slug: "gh_2.94.0_macOS_arm64",
			archiveName: "gh_2.94.0_macOS_arm64.zip",
			url: "https://github.com/cli/cli/releases/download/v2.94.0/gh_2.94.0_macOS_arm64.zip",
			sha256:
				"4f9bc1a5e77500737290a307b40b4c396a4d23729f55340f2a83f414410165a1",
		});
		expect(glabArchivePlan(target)).toEqual({
			slug: "glab_1.102.0_darwin_arm64",
			archiveName: "glab_1.102.0_darwin_arm64.tar.gz",
			url: "https://gitlab.com/gitlab-org/cli/-/releases/v1.102.0/downloads/glab_1.102.0_darwin_arm64.tar.gz",
			sha256:
				"24638bda18b6f3b1433ea9909f71df3787866ef525f34aaf2c4a25c53f6ff651",
		});
		expect(cloudflaredArchivePlan(target)).toEqual({
			slug: "cloudflared-darwin-arm64",
			archiveName: "cloudflared-2026.6.0-darwin-arm64.tgz",
			url: "https://github.com/cloudflare/cloudflared/releases/download/2026.6.0/cloudflared-darwin-arm64.tgz",
			sha256:
				"88e17987423d3fd49167305f8bda14d83a80ab9f2097ff9c82b317a39e342119",
		});
		expect(claudeCodeArchivePlan(target, "2.1.154")).toEqual({
			slug: "claude-code-darwin-arm64-2.1.154",
			archiveName: "claude-code-darwin-arm64-2.1.154.tgz",
			url: "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.154.tgz",
			sha256:
				"2394afa765253caaac8cb030c7954650c4052b537aacc664c634d6397bed064a",
		});
		expect(codexArchivePlan(target, "0.134.0")).toEqual({
			slug: "codex-0.134.0-darwin-arm64",
			archiveName: "codex-0.134.0-darwin-arm64.tgz",
			url: "https://registry.npmjs.org/@openai/codex/-/codex-0.134.0-darwin-arm64.tgz",
			sha256:
				"82c8bd152cdfb8175fd03d1d18ac0f8cddce22a7e68164572c107f628b0d8b7c",
		});
		expect(opencodeArchivePlan(target, "1.16.2")).toEqual({
			slug: "opencode-darwin-arm64-1.16.2",
			archiveName: "opencode-darwin-arm64-1.16.2.tgz",
			url: "https://registry.npmjs.org/opencode-darwin-arm64/-/opencode-darwin-arm64-1.16.2.tgz",
			sha256:
				"2103383d7562c1783cb66d63d31630ff90448d1ade90f8a187778d18c4b9ee5f",
		});
		expect(llamaArchivePlan(target)).toEqual({
			slug: "llama-b9496-bin-macos-arm64",
			archiveName: "llama-b9496-bin-macos-arm64.tar.gz",
			url: "https://github.com/ggml-org/llama.cpp/releases/download/b9496/llama-b9496-bin-macos-arm64.tar.gz",
			sha256:
				"f1eff7bb49590d80706b84e82e973a21f0bedb49560fbabfea2654756aa59dca",
		});
	});

	test("keeps current x64 vendor archive plans unchanged", () => {
		const target = targetInfoForArch("x64");
		expect(ghArchivePlan(target).archiveName).toBe("gh_2.94.0_macOS_amd64.zip");
		expect(glabArchivePlan(target).archiveName).toBe(
			"glab_1.102.0_darwin_amd64.tar.gz",
		);
		expect(cloudflaredArchivePlan(target).archiveName).toBe(
			"cloudflared-2026.6.0-darwin-amd64.tgz",
		);
		expect(claudeCodeArchivePlan(target, "2.1.154").archiveName).toBe(
			"claude-code-darwin-x64-2.1.154.tgz",
		);
		expect(codexArchivePlan(target, "0.134.0").archiveName).toBe(
			"codex-0.134.0-darwin-x64.tgz",
		);
		expect(opencodeArchivePlan(target, "1.16.2").archiveName).toBe(
			"opencode-darwin-x64-1.16.2.tgz",
		);
		expect(llamaArchivePlan(target).archiveName).toBe(
			"llama-b9496-bin-macos-x64.tar.gz",
		);
	});
});
