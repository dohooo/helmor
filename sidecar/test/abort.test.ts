import { describe, expect, test } from "bun:test";
import { isAbortError } from "../src/abort.js";

describe("isAbortError", () => {
	test("matches DOMException-style AbortError by name", () => {
		expect(isAbortError({ name: "AbortError" })).toBe(true);
	});

	test("matches Node-style ABORT_ERR by code", () => {
		expect(isAbortError({ code: "ABORT_ERR" })).toBe(true);
	});

	test("matches error whose message contains 'aborted'", () => {
		expect(isAbortError({ message: "The operation was aborted" })).toBe(true);
	});

	test("matches case-insensitively on message", () => {
		expect(isAbortError({ message: "REQUEST ABORTED BY USER" })).toBe(true);
	});

	test("matches real Error subclass", () => {
		const e = new Error("aborted");
		e.name = "AbortError";
		expect(isAbortError(e)).toBe(true);
	});

	test("rejects null", () => {
		expect(isAbortError(null)).toBe(false);
	});

	test("rejects undefined", () => {
		expect(isAbortError(undefined)).toBe(false);
	});

	test("rejects plain string", () => {
		expect(isAbortError("aborted")).toBe(false);
	});

	test("rejects number", () => {
		expect(isAbortError(42)).toBe(false);
	});

	test("rejects unrelated error", () => {
		expect(isAbortError(new Error("network failure"))).toBe(false);
	});

	test("rejects error with no distinguishing fields", () => {
		expect(isAbortError({ foo: "bar" })).toBe(false);
	});
});
