import { describe, expect, it } from "vitest";
import { normalizeBranchRenameInput } from "./branch-rename";

describe("normalizeBranchRenameInput", () => {
	it("trims surrounding whitespace", () => {
		expect(normalizeBranchRenameInput("  feature/foo  ")).toBe("feature/foo");
	});

	it("converts whitespace runs to hyphens", () => {
		expect(normalizeBranchRenameInput("fix broken branch rename")).toBe(
			"fix-broken-branch-rename",
		);
		expect(normalizeBranchRenameInput("fix\tbroken\nbranch")).toBe(
			"fix-broken-branch",
		);
	});

	it("leaves non-whitespace branch characters for git to validate", () => {
		expect(normalizeBranchRenameInput("feature/foo_bar")).toBe(
			"feature/foo_bar",
		);
	});
});
