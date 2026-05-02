import { describe, expect, it } from "vitest";
import type {
	ChangeRequestInfo,
	ForgeActionStatus,
	WorkspaceGitActionStatus,
} from "./api";
import {
	type CommitLifecycle,
	deriveCommitButtonMode,
	deriveCommitButtonState,
} from "./commit-button-logic";

// ── Helpers ──────────────────────────────────────────────────────────

function makeChangeRequest(
	overrides: Partial<ChangeRequestInfo> = {},
): ChangeRequestInfo {
	return {
		url: "https://github.com/test/repo/pull/1",
		number: 1,
		state: "OPEN",
		title: "test change request",
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
		changeRequest: null,
		...overrides,
	};
}

function makeChangeRequestActionStatus(
	overrides: Partial<ForgeActionStatus> = {},
): ForgeActionStatus {
	return {
		changeRequest: null,
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
		aheadOfTargetCount: 0,
		pushStatus: "published",
		...overrides,
	};
}

// ── deriveCommitButtonMode ───────────────────────────────────────────

describe("deriveCommitButtonMode", () => {
	describe("resting state (no lifecycle)", () => {
		it("returns create-pr when no change request exists", () => {
			expect(deriveCommitButtonMode(null, null)).toBe("create-pr");
		});

		it("returns merge when change request is OPEN and no blocking conditions", () => {
			expect(
				deriveCommitButtonMode(null, makeChangeRequest({ state: "OPEN" })),
			).toBe("merge");
		});

		it("returns merged when change request is merged", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "MERGED", isMerged: true }),
				),
			).toBe("merged");
		});

		it("returns open-pr when change request is CLOSED (not merged)", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "CLOSED", isMerged: false }),
				),
			).toBe("open-pr");
		});
	});

	describe("resolve-conflicts priority", () => {
		it("returns resolve-conflicts when mergeable is CONFLICTING", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({ mergeable: "CONFLICTING" }),
				),
			).toBe("resolve-conflicts");
		});

		it("returns resolve-conflicts when local conflictCount > 0", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus(),
					makeGitActionStatus({ conflictCount: 3 }),
				),
			).toBe("resolve-conflicts");
		});

		it("conflicts take precedence over uncommitted changes", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({ mergeable: "CONFLICTING" }),
					makeGitActionStatus({ uncommittedCount: 5 }),
				),
			).toBe("resolve-conflicts");
		});

		it("conflicts take precedence over failing checks", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({
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
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({ mergeable: "MERGEABLE" }),
					makeGitActionStatus({ uncommittedCount: 2 }),
				),
			).toBe("commit-and-push");
		});

		it("uncommitted changes take precedence over failing checks", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({
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
		it("returns push when the branch has not been published yet", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({ mergeable: "MERGEABLE" }),
					makeGitActionStatus({ pushStatus: "unpublished" }),
				),
			).toBe("push");
		});

		it("returns push when local branch is ahead of remote", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({ mergeable: "MERGEABLE" }),
					makeGitActionStatus({ aheadOfRemoteCount: 2 }),
				),
			).toBe("push");
		});

		it("ahead-of-remote takes precedence over failing checks", () => {
			expect(
				deriveCommitButtonMode(
					null,
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({
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
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({
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
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({
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
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({
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
		it("returns merge when change request is OPEN with only 2 args", () => {
			expect(
				deriveCommitButtonMode(null, makeChangeRequest({ state: "OPEN" })),
			).toBe("merge");
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
						changeRequest: makeChangeRequest({
							state: "OPEN",
							isMerged: false,
						}),
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
						changeRequest: makeChangeRequest({
							state: "MERGED",
							isMerged: true,
						}),
					}),
					null,
				),
			).toBe("merged");
		});

		it("returns lifecycle mode on error (no change request)", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({
						mode: "create-pr",
						phase: "error",
						changeRequest: null,
					}),
					null,
				),
			).toBe("create-pr");
		});

		it("lifecycle takes priority over PR query and action statuses", () => {
			expect(
				deriveCommitButtonMode(
					makeLifecycle({ mode: "create-pr", phase: "streaming" }),
					makeChangeRequest({ state: "OPEN" }),
					makeChangeRequestActionStatus({ mergeable: "CONFLICTING" }),
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

	it("returns disabled when merge mode hits UNKNOWN mergeable", () => {
		expect(
			deriveCommitButtonState(
				null,
				makeChangeRequestActionStatus({ mergeable: "UNKNOWN" }),
				"merge",
			),
		).toBe("disabled");
	});

	it("returns idle when mergeable is MERGEABLE", () => {
		expect(
			deriveCommitButtonState(
				null,
				makeChangeRequestActionStatus({ mergeable: "MERGEABLE" }),
				"merge",
			),
		).toBe("idle");
	});

	// Regression: GitLab maps `not_open` → "UNKNOWN" and the action-status
	// poller stops once a PR is merged/closed, so the last recorded mergeable
	// sticks on UNKNOWN forever. Tying the disabled gate to mode="merge"
	// (not "merged"/"closed") prevents that stale UNKNOWN from leaking into
	// the ghost-mode header.
	it("returns idle for merged mode even when mergeable is UNKNOWN", () => {
		expect(
			deriveCommitButtonState(
				null,
				makeChangeRequestActionStatus({ mergeable: "UNKNOWN" }),
				"merged",
			),
		).toBe("idle");
	});

	it("returns idle for closed mode even when mergeable is UNKNOWN", () => {
		expect(
			deriveCommitButtonState(
				null,
				makeChangeRequestActionStatus({ mergeable: "UNKNOWN" }),
				"closed",
			),
		).toBe("idle");
	});

	// Regression: actions like Fix CI / Push / Commit-and-push don't depend
	// on mergeability — they shouldn't be greyed out while GitHub is still
	// computing it.
	it.each([
		"fix",
		"push",
		"commit-and-push",
		"resolve-conflicts",
	] as const)("returns idle for %s mode even when mergeable is UNKNOWN", (mode) => {
		expect(
			deriveCommitButtonState(
				null,
				makeChangeRequestActionStatus({ mergeable: "UNKNOWN" }),
				mode,
			),
		).toBe("idle");
	});

	it("returns idle when mode is undefined (no PR yet)", () => {
		expect(
			deriveCommitButtonState(
				null,
				makeChangeRequestActionStatus({ mergeable: "UNKNOWN" }),
			),
		).toBe("idle");
	});

	it("returns idle when no forgeActionStatus", () => {
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
				makeChangeRequestActionStatus({ mergeable: "UNKNOWN" }),
			),
		).toBe("busy");
	});
});
