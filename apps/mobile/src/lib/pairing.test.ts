import { describe, expect, it } from "bun:test";

import { parsePairingUrl } from "./pairing";

const now = () => new Date("2026-01-02T03:04:05.000Z");

describe("parsePairingUrl", () => {
	it("parses a companion #pair token", () => {
		expect(parsePairingUrl("https://helmor.test/#pair=hlm_abc", now)).toEqual({
			baseUrl: "https://helmor.test",
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
			token: "hlm_lan",
			pairedAt: "2026-01-02T03:04:05.000Z",
			originalUrl:
				"helmor://pair?baseUrl=http%3A%2F%2F192.168.1.20%3A58758&token=hlm_lan",
		});
	});

	it("rejects non-http links and links without a token", () => {
		expect(parsePairingUrl("helmor://pair?token=hlm_abc", now)).toBeNull();
		expect(parsePairingUrl("https://helmor.test/", now)).toBeNull();
	});
});
