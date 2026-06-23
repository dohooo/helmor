// Custom Codex provider plumbing: parse + inject into thread params.

import { describe, expect, test } from "bun:test";
import {
	parseCodexProvider,
	parseSendMessageParams,
} from "../request-parser.js";
import { applyCodexProviderConfig } from "./app-server-manager.js";

const VALID = {
	id: "hundun",
	baseUrl: "http://dollar.hundun.cn/v1",
	apiKey: "sk-secret",
	wireApi: "responses",
	model: "gpt-5.5",
};

describe("parseCodexProvider", () => {
	test("returns undefined when absent", () => {
		expect(parseCodexProvider({}, "codexProvider")).toBeUndefined();
		expect(
			parseCodexProvider({ codexProvider: null }, "codexProvider"),
		).toBeUndefined();
	});

	test("narrows a valid block", () => {
		expect(
			parseCodexProvider({ codexProvider: VALID }, "codexProvider"),
		).toEqual(VALID);
	});

	test("defaults wireApi to responses and allows empty apiKey", () => {
		const parsed = parseCodexProvider(
			{ codexProvider: { id: "x", baseUrl: "http://x/v1", model: "m" } },
			"codexProvider",
		);
		expect(parsed).toEqual({
			id: "x",
			baseUrl: "http://x/v1",
			model: "m",
			apiKey: "",
			wireApi: "responses",
		});
	});

	test("throws on missing required fields", () => {
		expect(() =>
			parseCodexProvider(
				{ codexProvider: { id: "x", baseUrl: "http://x/v1" } },
				"codexProvider",
			),
		).toThrow();
		expect(() =>
			parseCodexProvider({ codexProvider: [] }, "codexProvider"),
		).toThrow();
	});

	test("flows through parseSendMessageParams", () => {
		const params = parseSendMessageParams({
			sessionId: "s",
			prompt: "hi",
			provider: "codex",
			model: "gpt-5.5",
			codexProvider: VALID,
		});
		expect(params.codexProvider).toEqual(VALID);
	});
});

describe("applyCodexProviderConfig", () => {
	test("no-op when undefined", () => {
		const target: Record<string, unknown> = { model: "gpt-5.5" };
		applyCodexProviderConfig(target, undefined);
		expect(target).toEqual({ model: "gpt-5.5" });
	});

	test("injects modelProvider + config with bearer token", () => {
		const target: Record<string, unknown> = { model: "gpt-5.5" };
		applyCodexProviderConfig(target, VALID);
		expect(target.modelProvider).toBe("hundun");
		expect(target.config).toEqual({
			model_providers: {
				hundun: {
					name: "hundun",
					base_url: "http://dollar.hundun.cn/v1",
					wire_api: "responses",
					experimental_bearer_token: "sk-secret",
				},
			},
		});
	});

	test("falls back to responses wire_api when blank", () => {
		const target: Record<string, unknown> = {};
		applyCodexProviderConfig(target, { ...VALID, wireApi: "" });
		const providers = (target.config as Record<string, unknown>)
			.model_providers as Record<string, Record<string, unknown>>;
		expect(providers.hundun?.wire_api).toBe("responses");
	});
});
