import { describe, expect, it } from "bun:test";

import type { NativePairing } from "./pairing";
import {
	companionBootstrapScript,
	companionWebViewUrl,
} from "./webview-bootstrap";

describe("companionWebViewUrl", () => {
	it("opens the companion shell with a token hash fallback", () => {
		const pairing: NativePairing = {
			baseUrl: "http://192.168.1.20:58758",
			token: "hlm_lan",
			pairedAt: "2026-01-02T03:04:05.000Z",
			originalUrl:
				"helmor://pair?baseUrl=http%3A%2F%2F192.168.1.20%3A58758&token=hlm_lan",
		};

		expect(companionWebViewUrl(pairing)).toBe(
			"http://192.168.1.20:58758/#token=hlm_lan",
		);
	});

	it("injects the pairing token into the companion global", () => {
		const pairing: NativePairing = {
			baseUrl: "http://192.168.1.20:58758",
			token: "hlm_lan",
			pairedAt: "2026-01-02T03:04:05.000Z",
			originalUrl:
				"helmor://pair?baseUrl=http%3A%2F%2F192.168.1.20%3A58758&token=hlm_lan",
		};

		expect(companionBootstrapScript(pairing, { top: 0, bottom: 0 })).toContain(
			"window.__HELMOR_COMPANION__ = companion",
		);
	});

	it("installs WebView diagnostics", () => {
		const pairing: NativePairing = {
			baseUrl: "http://192.168.1.20:58758",
			token: "hlm_lan",
			pairedAt: "2026-01-02T03:04:05.000Z",
			originalUrl:
				"helmor://pair?baseUrl=http%3A%2F%2F192.168.1.20%3A58758&token=hlm_lan",
		};

		const script = companionBootstrapScript(pairing, { top: 0, bottom: 0 });
		expect(script).toContain("helmor:webview-diagnostic");
		expect(script).toContain("window.onerror");
		expect(script).toContain("unhandledrejection");
	});
});
