import { describe, expect, test } from "bun:test";
import { parseMacSystemProxy } from "../src/agent-proxy.js";
import {
	buildCodexAppServerArgs,
	buildCodexEnv,
} from "../src/codex-app-server.js";

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
