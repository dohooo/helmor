import { describe, expect, it } from "vitest";
import { classifyCloudError, describeCloudError } from "./cloud-error-cta";

describe("classifyCloudError", () => {
	it.each([
		["Request failed: Unauthorized", "auth"],
		["HTTP 401 from broker", "auth"],
		["No cloud identity configured", "auth"],
		["Cloud Claude needs re-authorization", "auth"],
		["Your token expired, please sign in again", "auth"],
		["Agent SDK credit balance is too low", "billing"],
		["Billing problem on the team account", "billing"],
	] as const)("maps %j to %j", (message, expected) => {
		expect(classifyCloudError(message)).toBe(expected);
	});

	it("is case-insensitive", () => {
		expect(classifyCloudError("UNAUTHORIZED")).toBe("auth");
		expect(classifyCloudError("Agent SDK Credit exhausted")).toBe("billing");
	});

	it("prefers auth over billing when both phrasings appear", () => {
		expect(classifyCloudError("unauthorized: billing also failed")).toBe(
			"auth",
		);
	});

	it.each([
		["A generic tool error"],
		["Connection reset by peer"],
		["The file was not found"],
		[""],
		[null],
		[undefined],
	] as const)("returns null for unrelated message %j", (message) => {
		expect(classifyCloudError(message)).toBeNull();
	});
});

describe("describeCloudError", () => {
	it("maps the browser network 'Load failed' to friendly copy", () => {
		expect(describeCloudError("Load failed")).toMatch(/can't reach the team/i);
		expect(describeCloudError("Failed to fetch")).toMatch(
			/can't reach the team/i,
		);
	});

	it("maps the Worker permanent container error to a re-run-setup hint", () => {
		expect(
			describeCloudError(
				"serve host not ready: Container failed to start due to a permanent error. Check your container configuration.",
			),
		).toMatch(/sandbox can't start/i);
	});

	it("passes through an already-human-readable message unchanged", () => {
		const msg = "Codex run stopped: rate limited, try again shortly.";
		expect(describeCloudError(msg)).toBe(msg);
	});

	it("returns a generic line for an empty/absent message", () => {
		expect(describeCloudError("")).toMatch(/failed/i);
		expect(describeCloudError(null)).toMatch(/failed/i);
		expect(describeCloudError(undefined)).toMatch(/failed/i);
	});
});
