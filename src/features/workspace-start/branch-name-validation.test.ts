import { describe, expect, it } from "vitest";
import { validateBranchName } from "./branch-name-validation";

describe("validateBranchName", () => {
	it("accepts simple names with prefix slashes", () => {
		expect(validateBranchName("nathan/foo")).toBeNull();
		expect(validateBranchName("feature/x-y-z")).toBeNull();
		expect(validateBranchName("plain")).toBeNull();
	});

	it("rejects empty / whitespace-only input", () => {
		expect(validateBranchName("")).toMatch(/empty/);
		expect(validateBranchName("   ")).toMatch(/empty/);
	});

	it("rejects trailing slash", () => {
		expect(validateBranchName("codex/")).toMatch(/end with "\/"/);
	});

	it("rejects leading slash / dot / dash", () => {
		expect(validateBranchName("/foo")).toMatch(/cannot start/);
		expect(validateBranchName(".foo")).toMatch(/cannot start/);
		expect(validateBranchName("-foo")).toMatch(/cannot start/);
	});

	it('rejects ".."', () => {
		expect(validateBranchName("foo..bar")).toMatch(/\.\./);
	});

	it("rejects whitespace", () => {
		expect(validateBranchName("foo bar")).toMatch(/whitespace/);
		expect(validateBranchName("foo\tbar")).toMatch(/whitespace/);
	});

	it("rejects banned characters", () => {
		for (const ch of ["~", "^", ":", "?", "*", "[", "\\"]) {
			expect(validateBranchName(`foo${ch}bar`)).toMatch(/invalid character/);
		}
	});

	it('rejects ".lock" suffix', () => {
		expect(validateBranchName("foo.lock")).toMatch(/\.lock/);
	});

	it('rejects "@{"', () => {
		expect(validateBranchName("foo@{bar")).toMatch(/@\{/);
	});

	it("rejects names that already exist", () => {
		expect(validateBranchName("main", ["main", "develop"])).toMatch(
			/already exists/,
		);
		expect(validateBranchName("feature/new", ["main", "develop"])).toBeNull();
	});

	it("trims input before checking emptiness", () => {
		// Trim is applied first, so an effectively-empty input fails.
		expect(validateBranchName("   ")).toMatch(/empty/);
		// Surrounding whitespace is OK if the name is otherwise valid.
		expect(validateBranchName("  feature/x  ")).toBeNull();
	});
});
