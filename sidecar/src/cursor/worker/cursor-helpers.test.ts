import { describe, expect, test } from "bun:test";
import { isAgentBusyError, isAuthError } from "./cursor-helpers.js";

describe("isAgentBusyError", () => {
	test("matches the local store's plain 'already has active run' Error", () => {
		const err = new Error(
			"Agent agent-3adca04b-04a5-4491-baf5-1bf9914e1629 already has active run",
		);
		expect(isAgentBusyError(err)).toBe(true);
	});

	test("matches the 'already has an active run' wording too", () => {
		expect(
			isAgentBusyError(new Error("Agent x already has an active run")),
		).toBe(true);
	});

	test("matches by AgentBusyError class/errorName", () => {
		expect(isAgentBusyError({ name: "AgentBusyError" })).toBe(true);
		expect(isAgentBusyError({ errorName: "AgentBusyError" })).toBe(true);
	});

	test("walks the cause chain", () => {
		const wrapped = new Error("send failed");
		(wrapped as { cause?: unknown }).cause = new Error(
			"Agent y already has active run",
		);
		expect(isAgentBusyError(wrapped)).toBe(true);
	});

	test("does not match unrelated errors", () => {
		expect(isAgentBusyError(new Error("ECONNRESET"))).toBe(false);
		expect(isAgentBusyError(new Error("[unauthenticated] Error"))).toBe(false);
		expect(isAgentBusyError(null)).toBe(false);
		expect(isAgentBusyError(undefined)).toBe(false);
	});
});

describe("isAuthError", () => {
	test("matches a raw ConnectError [unauthenticated] message", () => {
		expect(isAuthError(new Error("[unauthenticated] Error"))).toBe(true);
	});

	test("matches by ConnectError code", () => {
		expect(isAuthError({ code: "unauthenticated", message: "Error" })).toBe(
			true,
		);
		expect(isAuthError({ code: "permission_denied" })).toBe(true);
	});

	test("matches the wrapped AuthenticationError class", () => {
		expect(isAuthError({ name: "AuthenticationError" })).toBe(true);
		expect(isAuthError({ errorName: "AuthenticationError" })).toBe(true);
	});

	test("matches 'invalid api key' text", () => {
		expect(
			isAuthError(new Error("Invalid API key. Please check your key.")),
		).toBe(true);
	});

	test("walks the cause chain", () => {
		const wrapped = new Error("send failed");
		(wrapped as { cause?: unknown }).cause = {
			code: "unauthenticated",
		};
		expect(isAuthError(wrapped)).toBe(true);
	});

	test("does not match network or busy errors", () => {
		expect(isAuthError(new Error("ECONNRESET"))).toBe(false);
		expect(isAuthError(new Error("Agent x already has active run"))).toBe(
			false,
		);
		expect(isAuthError(null)).toBe(false);
	});
});
