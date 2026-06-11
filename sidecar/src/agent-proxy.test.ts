import { afterEach, describe, expect, test } from "bun:test";
import {
	applyAgentProxyToProcessEnv,
	parseMacSystemProxy,
} from "./agent-proxy.js";

const PROXY_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
];

describe("parseMacSystemProxy", () => {
	test("prefers HTTPS, builds scheme://host:port", () => {
		const out = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : proxy.lan
  HTTPPort : 3128
  HTTPSEnable : 1
  HTTPSProxy : secure.lan
  HTTPSPort : 8443
}`;
		expect(parseMacSystemProxy(out)).toBe("http://secure.lan:8443");
	});

	test("falls back to HTTP when HTTPS disabled", () => {
		const out = `HTTPEnable : 1\nHTTPProxy : proxy.lan\nHTTPPort : 3128\nHTTPSEnable : 0`;
		expect(parseMacSystemProxy(out)).toBe("http://proxy.lan:3128");
	});

	test("SOCKS uses socks5 scheme", () => {
		const out = `SOCKSEnable : 1\nSOCKSProxy : socks.lan\nSOCKSPort : 1080`;
		expect(parseMacSystemProxy(out)).toBe("socks5://socks.lan:1080");
	});

	test("returns null when nothing enabled", () => {
		expect(parseMacSystemProxy("HTTPEnable : 0\nHTTPSEnable : 0")).toBeNull();
	});
});

describe("applyAgentProxyToProcessEnv", () => {
	afterEach(() => {
		for (const key of PROXY_KEYS) delete process.env[key];
	});

	test("clears all proxy env keys when no proxy is configured", () => {
		for (const key of PROXY_KEYS) process.env[key] = "http://stale:1";
		applyAgentProxyToProcessEnv(undefined);
		for (const key of PROXY_KEYS) expect(process.env[key]).toBeUndefined();
	});

	// The proxy feature is macOS-only (see buildAgentProxyEnv's platform guard).
	test.if(process.platform === "darwin")(
		"sets all proxy env keys for a custom proxy",
		() => {
			applyAgentProxyToProcessEnv({
				mode: "custom",
				customUrl: "http://127.0.0.1:7890",
			});
			for (const key of PROXY_KEYS) {
				expect(process.env[key]).toBe("http://127.0.0.1:7890");
			}
		},
	);
});
