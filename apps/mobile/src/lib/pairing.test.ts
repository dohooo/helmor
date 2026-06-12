import { describe, expect, it } from "bun:test";

import {
	normalizeNativePairing,
	parsePairingUrl,
	validatePairing,
} from "./pairing";

const now = () => new Date("2026-01-02T03:04:05.000Z");

describe("parsePairingUrl", () => {
	it("parses a companion #pair token", () => {
		expect(parsePairingUrl("https://helmor.test/#pair=hlm_abc", now)).toEqual({
			baseUrl: "https://helmor.test",
			connectionKind: "temporary",
			token: "hlm_abc",
			pairedAt: "2026-01-02T03:04:05.000Z",
			originalUrl: "https://helmor.test/#pair=hlm_abc",
		});
	});

	it("parses a companion #token token", () => {
		expect(
			parsePairingUrl("https://helmor.test/#token=hlm_def", now)?.token,
		).toBe("hlm_def");
	});

	it("parses a native app pairing link", () => {
		expect(
			parsePairingUrl(
				"helmor://pair?baseUrl=http%3A%2F%2F192.168.1.20%3A58758&token=hlm_lan",
				now,
			),
		).toEqual({
			baseUrl: "http://192.168.1.20:58758",
			connectionKind: "temporary",
			token: "hlm_lan",
			pairedAt: "2026-01-02T03:04:05.000Z",
			originalUrl:
				"helmor://pair?baseUrl=http%3A%2F%2F192.168.1.20%3A58758&token=hlm_lan",
		});
	});

	it("parses fixed pairing links", () => {
		expect(
			parsePairingUrl(
				"helmor://pair?baseUrl=https%3A%2F%2Fremote-abcd.helmor.ai&token=hlm_fixed&kind=fixed",
				now,
			)?.connectionKind,
		).toBe("fixed");
	});

	it("rejects non-http links and links without a token", () => {
		expect(parsePairingUrl("helmor://pair?token=hlm_abc", now)).toBeNull();
		expect(parsePairingUrl("https://helmor.test/", now)).toBeNull();
	});
});

describe("normalizeNativePairing", () => {
	it("defaults old saved pairings to temporary", () => {
		expect(
			normalizeNativePairing({
				baseUrl: "https://helmor.test",
				token: "hlm_old",
				pairedAt: "2026-01-02T03:04:05.000Z",
				originalUrl: "https://helmor.test/#token=hlm_old",
			})?.connectionKind,
		).toBe("temporary");
	});
});

describe("validatePairing", () => {
	it("reports revoked pairings as stale connections", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.resolve(new Response("{}", { status: 401 }))) as typeof fetch;
		try {
			await expect(
				validatePairing({
					baseUrl: "https://helmor.test",
					connectionKind: "temporary",
					token: "hlm_old",
					pairedAt: "2026-01-02T03:04:05.000Z",
					originalUrl: "https://helmor.test/#token=hlm_old",
				}),
			).rejects.toThrow(/no longer valid/i);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps network failures distinct from stale pairings", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.reject(new Error("Network request failed"))) as typeof fetch;
		try {
			await expect(
				validatePairing({
					baseUrl: "https://helmor.test",
					connectionKind: "fixed",
					token: "hlm_fixed",
					pairedAt: "2026-01-02T03:04:05.000Z",
					originalUrl:
						"helmor://pair?baseUrl=https%3A%2F%2Fhelmor.test&token=hlm_fixed&kind=fixed",
				}),
			).rejects.toThrow(/Network request failed/i);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
