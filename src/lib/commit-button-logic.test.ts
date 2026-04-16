import { describe, expect, it } from "vitest";
import type {
	PullRequestInfo,
	WorkspaceGitActionStatus,
	WorkspacePrActionStatus,
} from "./api";
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

function makePrActionStatus(
	overrides: Partial<WorkspacePrActionStatus> = {},
): WorkspacePrActionStatus {
	return {
		pr: null,
		reviewDecision: null,
		mergeable: null,
		deployments: [],
		checks: [],
		remoteState: "ok",
		message: null,
		...overrides,
	};
}

function makeGitActionStatus(
	overrides: Partial<WorkspaceGitActionStatus> = {},
): WorkspaceGitActionStatus {
	return {
		uncommittedCount: 0,
		conflictCount: 0,
		syncTargetBranch: "main",
		syncStatus: "upToDate",
		behindTargetCount: 0,
		remoteTrackingRef: "refs/remotes/origin/main",
		aheadOfRemoteCount: 0,
		...overrides,
	};
}

// ── deriveCommitButtonMode ───────────────────────────────────────────

describe("deriveCommitButtonMode", () => {
	describe("resting state (no lifecycle)", () => {
		it("returns create-pr when no PR exists", () => {
			expect(deriveCommitButtonMode(null, null)).toBe("create-pr");
		});

		it("returns merge when PR is OPEN and no blocking conditions", () => {
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

		it("returns open-pr when PR is CLOSED (not merged)", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "CLOSED", isMerged: false }),
				),
			).toBe("open-pr");
		});
	});

	describe("resolve-conflicts priority", () => {
		it("returns resolve-conflicts when mergeable is CONFLICTING", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({ mergeable: "CONFLICTING" }),
				),
			).toBe("resolve-conflicts");
		});

		it("returns resolve-conflicts when local conflictCount > 0", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus(),
					makeGitActionStatus({ conflictCount: 3 }),
				),
			).toBe("resolve-conflicts");
		});

		it("conflicts take precedence over uncommitted changes", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({ mergeable: "CONFLICTING" }),
					makeGitActionStatus({ uncommittedCount: 5 }),
				),
			).toBe("resolve-conflicts");
		});

		it("conflicts take precedence over failing checks", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({
						mergeable: "CONFLICTING",
						checks: [
							{
								id: "ci-1",
								name: "build",
								provider: "github",
								status: "failure",
							},
						],
					}),
				),
			).toBe("resolve-conflicts");
		});
	});

	describe("commit-and-push priority", () => {
		it("returns commit-and-push when uncommittedCount > 0 and no conflicts", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({ mergeable: "MERGEABLE" }),
					makeGitActionStatus({ uncommittedCount: 2 }),
				),
			).toBe("commit-and-push");
		});

		it("uncommitted changes take precedence over failing checks", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({
						mergeable: "MERGEABLE",
						checks: [
							{
								id: "ci-1",
								name: "build",
								provider: "github",
								status: "failure",
							},
						],
					}),
					makeGitActionStatus({ uncommittedCount: 1 }),
				),
			).toBe("commit-and-push");
		});
	});

	describe("push priority", () => {
		it("returns push when local branch is ahead of remote", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({ mergeable: "MERGEABLE" }),
					makeGitActionStatus({ aheadOfRemoteCount: 2 }),
				),
			).toBe("push");
		});

		it("ahead-of-remote takes precedence over failing checks", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({
						mergeable: "MERGEABLE",
						checks: [
							{
								id: "ci-1",
								name: "build",
								provider: "github",
								status: "failure",
							},
						],
					}),
					makeGitActionStatus({ aheadOfRemoteCount: 1 }),
				),
			).toBe("push");
		});
	});

	describe("fix CI priority", () => {
		it("returns fix when a check has failure status", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({
						checks: [
							{
								id: "ci-1",
								name: "build",
								provider: "github",
								status: "failure",
							},
						],
					}),
					makeGitActionStatus(),
				),
			).toBe("fix");
		});

		it("returns merge when all checks pass", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({
						checks: [
							{
								id: "ci-1",
								name: "build",
								provider: "github",
								status: "success",
							},
						],
					}),
					makeGitActionStatus(),
				),
			).toBe("merge");
		});

		it("returns merge when checks are pending (not failure)", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makePr({ state: "OPEN" }),
					makePrActionStatus({
						checks: [
							{
								id: "ci-1",
								name: "build",
								provider: "github",
								status: "pending",
							},
						],
					}),
					makeGitActionStatus(),
				),
			).toBe("merge");
		});
	});

	describe("backward compatibility (no action status args)", () => {
		it("returns merge when PR is OPEN with only 2 args", () => {
			expect(deriveCommitButtonMode(null, makePr({ state: "OPEN" }))).toBe(
				"merge",
			);
		});

		it("returns create-pr with no args", () => {
			expect(deriveCommitButtonMode(null, null)).toBe("create-pr");
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

		it("lifecycle takes priority over PR query and action statuses", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({ mode: "create-pr", phase: "streaming" }),
					makePr({ state: "OPEN" }),
					makePrActionStatus({ mergeable: "CONFLICTING" }),
					makeGitActionStatus({ uncommittedCount: 5 }),
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

	it("returns disabled when mergeable is UNKNOWN", () => {
		expect(
			deriveCommitButtonState(
				null,
				makePrActionStatus({ mergeable: "UNKNOWN" }),
			),
		).toBe("disabled");
	});

	it("returns idle when mergeable is MERGEABLE", () => {
		expect(
			deriveCommitButtonState(
				null,
				makePrActionStatus({ mergeable: "MERGEABLE" }),
			),
		).toBe("idle");
	});

	it("returns idle when no prActionStatus", () => {
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

	it("lifecycle takes priority over UNKNOWN mergeable", () => {
		expect(
			deriveCommitButtonState(
				makeLifecycle({ phase: "streaming" }),
				makePrActionStatus({ mergeable: "UNKNOWN" }),
			),
		).toBe("busy");
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
