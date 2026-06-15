import { describe, expect, it } from "vitest";
import { classifyCloudError } from "./cloud-error-cta";

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
