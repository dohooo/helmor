import { describe, expect, it } from "vitest";
import type { PullRequestInfo } from "./api";
import {
	type CommitLifecycle,
	deriveCommitButtonMode,
	deriveCommitButtonState,
	deriveWorkspaceStatusFromPr,
} from "./commit-button-logic";

// ── Helpers ──────────────────────────────────────────────────────────

function makePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
	return {
		url: "https://github.com/test/repo/pull/1",
		number: 1,
		state: "OPEN",
		title: "test pr",
		isMerged: false,
		...overrides,
	};
}

function makeLifecycle(
	overrides: Partial<NonNullable<CommitLifecycle>> = {},
): NonNullable<CommitLifecycle> {
	return {
		workspaceId: "ws-1",
		trackedSessionId: null,
		mode: "create-pr",
		phase: "creating",
		prInfo: null,
		...overrides,
	};
}

// ── deriveCommitButtonMode ───────────────────────────────────────────

describe("deriveCommitButtonMode", () => {
	describe("resting state (no lifecycle)", () => {
		it("returns create-pr when no PR exists", () => {
			expect(deriveCommitButtonMode(null, null)).toBe("create-pr");
		});

		it("returns merge when PR is OPEN", () => {
			expect(deriveCommitButtonMode(null, makePr({ state: "OPEN" }))).toBe(
				"merge",
			);
		});

		it("returns merged when PR is merged", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "MERGED", isMerged: true }),
				),
			).toBe("merged");
		});

		it("returns create-pr when PR is CLOSED (not merged)", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "CLOSED", isMerged: false }),
				),
			).toBe("create-pr");
		});
	});

	describe("active lifecycle", () => {
		it("returns lifecycle mode during creating phase", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({ mode: "create-pr", phase: "creating" }),
					null,
				),
			).toBe("create-pr");
		});

		it("returns lifecycle mode during streaming phase", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({ mode: "create-pr", phase: "streaming" }),
					null,
				),
			).toBe("create-pr");
		});

		it("returns lifecycle mode during verifying phase", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({ mode: "create-pr", phase: "verifying" }),
					null,
				),
			).toBe("create-pr");
		});

		it("returns merge when done phase finds non-merged PR", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({
						mode: "create-pr",
						phase: "done",
						prInfo: makePr({ state: "OPEN", isMerged: false }),
					}),
					null,
				),
			).toBe("merge");
		});

		it("returns merged when done phase finds merged PR", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({
						mode: "merge",
						phase: "done",
						prInfo: makePr({ state: "MERGED", isMerged: true }),
					}),
					null,
				),
			).toBe("merged");
		});

		it("returns lifecycle mode on error (no prInfo)", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({ mode: "create-pr", phase: "error", prInfo: null }),
					null,
				),
			).toBe("create-pr");
		});

		it("lifecycle takes priority over PR query", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({ mode: "create-pr", phase: "streaming" }),
					makePr({ state: "OPEN" }),
				),
			).toBe("create-pr");
		});
	});
});

// ── deriveCommitButtonState ──────────────────────────────────────────

describe("deriveCommitButtonState", () => {
	it("returns idle when no lifecycle", () => {
		expect(deriveCommitButtonState(null)).toBe("idle");
	});

	it("returns busy during creating", () => {
		expect(deriveCommitButtonState(makeLifecycle({ phase: "creating" }))).toBe(
			"busy",
		);
	});

	it("returns busy during streaming", () => {
		expect(deriveCommitButtonState(makeLifecycle({ phase: "streaming" }))).toBe(
			"busy",
		);
	});

	it("returns busy during verifying", () => {
		expect(deriveCommitButtonState(makeLifecycle({ phase: "verifying" }))).toBe(
			"busy",
		);
	});

	it("returns done during done phase", () => {
		expect(deriveCommitButtonState(makeLifecycle({ phase: "done" }))).toBe(
			"done",
		);
	});

	it("returns error during error phase", () => {
		expect(deriveCommitButtonState(makeLifecycle({ phase: "error" }))).toBe(
			"error",
		);
	});
});

// ── deriveWorkspaceStatusFromPr ──────────────────────────────────────

describe("deriveWorkspaceStatusFromPr", () => {
	it("returns null when no PR", () => {
		expect(deriveWorkspaceStatusFromPr(null)).toBeNull();
	});

	it("returns review when PR is OPEN", () => {
		expect(deriveWorkspaceStatusFromPr(makePr({ state: "OPEN" }))).toBe(
			"review",
		);
	});

	it("returns done when PR is merged", () => {
		expect(
			deriveWorkspaceStatusFromPr(makePr({ state: "MERGED", isMerged: true })),
		).toBe("done");
	});

	it("returns canceled when PR is CLOSED (not merged)", () => {
		expect(
			deriveWorkspaceStatusFromPr(makePr({ state: "CLOSED", isMerged: false })),
		).toBe("canceled");
	});

	it("prioritizes isMerged over state string", () => {
		// Edge case: state is CLOSED but isMerged is true (GitHub sets
		// state to MERGED but some API paths return CLOSED when merged)
		expect(
			deriveWorkspaceStatusFromPr(makePr({ state: "CLOSED", isMerged: true })),
		).toBe("done");
	});
});
