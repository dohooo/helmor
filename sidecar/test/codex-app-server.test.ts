import { describe, expect, test } from "bun:test";
import { parseWindowsRegistryPathValue } from "../src/agent-path-env.js";
import { parseMacSystemProxy } from "../src/agent-proxy.js";
import {
	buildCodexAppServerArgs,
	buildCodexEnv,
} from "../src/codex/app-server.js";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: platform });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", { value: original });
	}
}

describe("buildCodexAppServerArgs", () => {
	test("disables native notify hooks for embedded app-server sessions", () => {
		expect(buildCodexAppServerArgs()).toEqual([
			"app-server",
			"-c",
			"notify=[]",
		]);
	});

	test("applies custom proxy env for app-server child process", () => {
		const env = withPlatform("darwin", () => {
			return buildCodexEnv("/tmp/codex", {
				mode: "custom",
				customUrl: "http://127.0.0.1:7890",
			});
		});

		expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
		expect(env.ALL_PROXY).toBe("http://127.0.0.1:7890");
	});

	test("ignores proxy settings outside macOS", () => {
		const env = withPlatform("linux", () => {
			return buildCodexEnv("/tmp/codex", {
				mode: "custom",
				customUrl: "http://127.0.0.1:7890",
			});
		});

		expect(env.HTTP_PROXY).toBe(process.env.HTTP_PROXY);
		expect(env.HTTPS_PROXY).toBe(process.env.HTTPS_PROXY);
		expect(env.ALL_PROXY).toBe(process.env.ALL_PROXY);
	});

	test("merges Windows machine and user PATH into spawned Codex env", () => {
		const env = buildCodexEnv("C:\\tools\\codex\\bin\\codex.exe", undefined, {
			baseEnv: {
				Path: "C:\\Existing\\bin;C:\\Users\\dildev\\bin",
				SystemRoot: "C:\\Windows",
				USERPROFILE: "C:\\Users\\dildev",
			},
			pathExists: (path) => path.endsWith("codex-path"),
			platform: "win32",
			readWindowsRegistryPath: (scope) =>
				scope === "machine"
					? "%SystemRoot%\\System32;C:\\Machine\\Tools"
					: "%USERPROFILE%\\bin;C:\\Existing\\bin",
		});

		const path = env.Path?.split(";") ?? [];
		expect(path[0]?.endsWith("codex-path")).toBe(true);
		expect(path.slice(1)).toEqual([
			"C:\\Windows\\System32",
			"C:\\Machine\\Tools",
			"C:\\Users\\dildev\\bin",
			"C:\\Existing\\bin",
		]);
		expect(env.PATH).toBeUndefined();
	});

	test("keeps non-Windows PATH behavior unchanged", () => {
		let registryRead = false;
		const env = buildCodexEnv("/tmp/codex", undefined, {
			baseEnv: { PATH: "/usr/bin" },
			pathExists: () => false,
			platform: "linux",
			readWindowsRegistryPath: () => {
				registryRead = true;
				return undefined;
			},
		});

		expect(env.PATH).toBe("/usr/bin");
		expect(registryRead).toBe(false);
	});

	test("parses Windows registry PATH query output", () => {
		expect(
			parseWindowsRegistryPathValue(`
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment
    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\Tools
`),
		).toBe("%SystemRoot%\\System32;C:\\Tools");
	});

	test("parses macOS system proxy output", () => {
		expect(
			parseMacSystemProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
}
`),
		).toBe("http://127.0.0.1:7890");
	});
});
