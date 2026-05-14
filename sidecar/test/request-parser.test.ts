import { describe, expect, test } from "bun:test";
import {
	errorMessage,
	optionalString,
	parseListSlashCommandsParams,
	parseProvider,
	parseRequest,
	parseSendMessageParams,
	requireString,
} from "../src/request-parser.js";

describe("parseRequest", () => {
	test("accepts a well-formed request", () => {
		const line = JSON.stringify({
			id: "req-1",
			method: "sendMessage",
			params: { sessionId: "s1" },
		});
		const result = parseRequest(line);
		expect(result.id).toBe("req-1");
		expect(result.method).toBe("sendMessage");
		expect(result.params).toEqual({ sessionId: "s1" });
	});

	test("rejects non-object top-level value", () => {
		expect(() => parseRequest("42")).toThrow("request must be an object");
		expect(() => parseRequest('"hi"')).toThrow("request must be an object");
		expect(() => parseRequest("null")).toThrow("request must be an object");
	});

	test("rejects missing id", () => {
		const line = JSON.stringify({ method: "ping", params: {} });
		expect(() => parseRequest(line)).toThrow("request.id must be a string");
	});

	test("rejects non-string method", () => {
		const line = JSON.stringify({ id: "r", method: 123, params: {} });
		expect(() => parseRequest(line)).toThrow("request.method must be a string");
	});

	test("rejects non-object params", () => {
		const line = JSON.stringify({ id: "r", method: "ping", params: "oops" });
		expect(() => parseRequest(line)).toThrow(
			"request.params must be an object",
		);
	});

	test("rejects invalid JSON", () => {
		expect(() => parseRequest("{not json}")).toThrow();
	});
});

describe("requireString", () => {
	test("returns the string value when present", () => {
		expect(requireString({ foo: "bar" }, "foo")).toBe("bar");
	});

	test("throws with key name when missing", () => {
		expect(() => requireString({}, "foo")).toThrow(
			"params.foo must be a string",
		);
	});

	test("throws when value is a number", () => {
		expect(() => requireString({ foo: 42 }, "foo")).toThrow(
			"params.foo must be a string",
		);
	});

	test("throws when value is null", () => {
		expect(() => requireString({ foo: null }, "foo")).toThrow(
			"params.foo must be a string",
		);
	});

	test("accepts empty string", () => {
		expect(requireString({ foo: "" }, "foo")).toBe("");
	});
});

describe("optionalString", () => {
	test("returns string when present", () => {
		expect(optionalString({ foo: "bar" }, "foo")).toBe("bar");
	});

	test("returns undefined when missing", () => {
		expect(optionalString({}, "foo")).toBeUndefined();
	});

	test("returns undefined when not a string", () => {
		expect(optionalString({ foo: 42 }, "foo")).toBeUndefined();
		expect(optionalString({ foo: null }, "foo")).toBeUndefined();
		expect(optionalString({ foo: true }, "foo")).toBeUndefined();
	});
});

describe("parseProvider", () => {
	test("accepts 'claude'", () => {
		expect(parseProvider("claude")).toBe("claude");
	});

	test("accepts 'codex'", () => {
		expect(parseProvider("codex")).toBe("codex");
	});

	test("rejects unknown string", () => {
		expect(() => parseProvider("openai")).toThrow("unknown provider: openai");
	});

	test("rejects undefined", () => {
		expect(() => parseProvider(undefined)).toThrow(
			"unknown provider: undefined",
		);
	});

	test("rejects null", () => {
		expect(() => parseProvider(null)).toThrow("unknown provider: null");
	});

	test("rejects non-string types", () => {
		expect(() => parseProvider(42)).toThrow();
	});
});

describe("parseSendMessageParams", () => {
	test("extracts required + optional fields", () => {
		const result = parseSendMessageParams({
			sessionId: "s1",
			prompt: "hello",
			model: "opus",
			cwd: "/tmp",
			resume: "sdk-123",
			permissionMode: "plan",
			effortLevel: "high",
		});
		expect(result).toEqual({
			sessionId: "s1",
			prompt: "hello",
			model: "opus",
			cwd: "/tmp",
			resume: "sdk-123",
			permissionMode: "plan",
			effortLevel: "high",
			fastMode: undefined,
			images: [],
			additionalDirectories: undefined,
		});
	});

	test("parses additionalDirectories, trimming and dropping empties", () => {
		const result = parseSendMessageParams({
			sessionId: "s1",
			prompt: "hello",
			additionalDirectories: ["  /abs/a  ", "", "/abs/b"],
		});
		expect(result.additionalDirectories).toEqual(["/abs/a", "/abs/b"]);
	});

	test("rejects non-array additionalDirectories", () => {
		expect(() =>
			parseSendMessageParams({
				sessionId: "s1",
				prompt: "hello",
				additionalDirectories: "/not/an/array",
			}),
		).toThrow("must be an array");
	});

	test("rejects non-string entries in additionalDirectories", () => {
		expect(() =>
			parseSendMessageParams({
				sessionId: "s1",
				prompt: "hello",
				additionalDirectories: ["/abs/a", 42],
			}),
		).toThrow("must contain strings");
	});

	test("leaves optional fields undefined when absent", () => {
		const result = parseSendMessageParams({
			sessionId: "s1",
			prompt: "hello",
		});
		expect(result.model).toBeUndefined();
		expect(result.cwd).toBeUndefined();
		expect(result.resume).toBeUndefined();
		expect(result.permissionMode).toBeUndefined();
		expect(result.effortLevel).toBeUndefined();
	});

	test("throws when sessionId is missing", () => {
		expect(() => parseSendMessageParams({ prompt: "x" })).toThrow(
			"params.sessionId must be a string",
		);
	});

	test("throws when prompt is missing", () => {
		expect(() => parseSendMessageParams({ sessionId: "s1" })).toThrow(
			"params.prompt must be a string",
		);
	});
});

describe("parseListSlashCommandsParams", () => {
	test("parses additionalDirectories, trimming and dropping empties", () => {
		const result = parseListSlashCommandsParams({
			cwd: "/tmp/workspace",
			additionalDirectories: ["  /abs/a  ", "", "/abs/b"],
		});
		expect(result).toEqual({
			cwd: "/tmp/workspace",
			additionalDirectories: ["/abs/a", "/abs/b"],
		});
	});
});

describe("errorMessage", () => {
	test("extracts message from Error instance", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});

	test("stringifies non-Error values", () => {
		expect(errorMessage("raw string")).toBe("raw string");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(null)).toBe("null");
		expect(errorMessage(undefined)).toBe("undefined");
	});

	test("stringifies objects without message", () => {
		expect(errorMessage({ code: "X" })).toBe("[object Object]");
	});
});
