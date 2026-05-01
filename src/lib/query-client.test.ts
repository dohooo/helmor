import { describe, expect, it } from "vitest";
import type {
	ChangeRequestInfo,
	ForgeActionItem,
	ForgeActionStatus,
	ForgeDetection,
} from "./api";
import {
	changeRequestRefetchInterval,
	forgeActionStatusRefetchInterval,
	workspaceForgeRefetchInterval,
} from "./query-client";

const OPEN_CHANGE_REQUEST: ChangeRequestInfo = {
	url: "https://github.com/acme/repo/pull/1",
	number: 1,
	state: "OPEN",
	title: "feat: thing",
	isMerged: false,
};

const MERGED_CHANGE_REQUEST: ChangeRequestInfo = {
	...OPEN_CHANGE_REQUEST,
	state: "MERGED",
	isMerged: true,
};

const CLOSED_CHANGE_REQUEST: ChangeRequestInfo = {
	...OPEN_CHANGE_REQUEST,
	state: "CLOSED",
	isMerged: false,
};

function action(
	status: ForgeActionItem["status"],
	overrides: Partial<ForgeActionItem> = {},
): ForgeActionItem {
	return {
		id: overrides.id ?? "a1",
		name: overrides.name ?? "CI",
		provider: overrides.provider ?? "github",
		status,
		...overrides,
	};
}

function actionStatus(
	overrides: Partial<ForgeActionStatus> = {},
): ForgeActionStatus {
	return {
		changeRequest: OPEN_CHANGE_REQUEST,
		reviewDecision: null,
		mergeable: "MERGEABLE",
		deployments: [],
		checks: [],
		remoteState: "ok",
		...overrides,
	};
}

function forgeDetection(
	overrides: Partial<ForgeDetection> = {},
): ForgeDetection {
	return {
		provider: "github",
		host: "github.com",
		namespace: "acme",
		repo: "repo",
		remoteUrl: "https://github.com/acme/repo.git",
		labels: {
			providerName: "GitHub",
			cliName: "gh",
			changeRequestName: "PR",
			changeRequestFullName: "pull request",
			connectAction: "Connect GitHub",
		},
		detectionSignals: [],
		...overrides,
	};
}

describe("changeRequestRefetchInterval", () => {
	it("polls every 60s when data is absent", () => {
		expect(changeRequestRefetchInterval(undefined)).toBe(60_000);
		expect(changeRequestRefetchInterval(null)).toBe(60_000);
	});

	it("polls every 60s for OPEN change requests", () => {
		expect(changeRequestRefetchInterval(OPEN_CHANGE_REQUEST)).toBe(60_000);
	});

	it("slows to 5min for MERGED change requests", () => {
		expect(changeRequestRefetchInterval(MERGED_CHANGE_REQUEST)).toBe(300_000);
	});

	it("slows to 5min when isMerged flag is set but state lags", () => {
		expect(
			changeRequestRefetchInterval({ ...OPEN_CHANGE_REQUEST, isMerged: true }),
		).toBe(300_000);
	});

	it("slows to 5min for CLOSED change requests", () => {
		expect(changeRequestRefetchInterval(CLOSED_CHANGE_REQUEST)).toBe(300_000);
	});
});

describe("forgeActionStatusRefetchInterval", () => {
	it("polls every 60s when data is absent", () => {
		expect(forgeActionStatusRefetchInterval(undefined)).toBe(60_000);
	});

	it("keeps 60s probing when remoteState is not ok", () => {
		for (const remoteState of [
			"noPr",
			"unauthenticated",
			"unavailable",
			"error",
		] as const) {
			expect(
				forgeActionStatusRefetchInterval(actionStatus({ remoteState })),
			).toBe(60_000);
		}
	});

	it("stops polling once the change request is MERGED", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({ changeRequest: MERGED_CHANGE_REQUEST }),
			),
		).toBe(false);
	});

	it("stops polling once the change request is CLOSED", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({ changeRequest: CLOSED_CHANGE_REQUEST }),
			),
		).toBe(false);
	});

	it("stops polling when isMerged flag is set even if state lags", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({
					changeRequest: { ...OPEN_CHANGE_REQUEST, isMerged: true },
				}),
			),
		).toBe(false);
	});

	it("polls every 5s while mergeability is UNKNOWN", () => {
		expect(
			forgeActionStatusRefetchInterval(actionStatus({ mergeable: "UNKNOWN" })),
		).toBe(5_000);
	});

	it("prefers the terminal tier over UNKNOWN mergeable (MERGED wins)", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({
					changeRequest: MERGED_CHANGE_REQUEST,
					mergeable: "UNKNOWN",
				}),
			),
		).toBe(false);
	});

	it("polls every 15s when a check is running", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({ checks: [action("running")] }),
			),
		).toBe(15_000);
	});

	it("polls every 15s when a check is pending", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({ checks: [action("pending")] }),
			),
		).toBe(15_000);
	});

	it("polls every 15s when a deployment is running", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({ deployments: [action("running", { id: "d1" })] }),
			),
		).toBe(15_000);
	});

	it("polls every 15s when a deployment is pending", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({ deployments: [action("pending", { id: "d1" })] }),
			),
		).toBe(15_000);
	});

	it("polls every 60s when every check and deployment is settled", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({
					checks: [action("success"), action("failure", { id: "c2" })],
					deployments: [action("success", { id: "d1" })],
				}),
			),
		).toBe(60_000);
	});

	it("prefers UNKNOWN mergeable over running checks (5s beats 15s)", () => {
		expect(
			forgeActionStatusRefetchInterval(
				actionStatus({
					mergeable: "UNKNOWN",
					checks: [action("running")],
				}),
			),
		).toBe(5_000);
	});
});

describe("workspaceForgeRefetchInterval", () => {
	it("keeps probing supported forges so CLI install state can change", () => {
		expect(workspaceForgeRefetchInterval(undefined)).toBe(60_000);
		expect(
			workspaceForgeRefetchInterval(forgeDetection({ provider: "github" })),
		).toBe(60_000);
		expect(
			workspaceForgeRefetchInterval(forgeDetection({ provider: "gitlab" })),
		).toBe(60_000);
	});

	it("stops probing unknown remotes", () => {
		expect(
			workspaceForgeRefetchInterval(forgeDetection({ provider: "unknown" })),
		).toBe(false);
	});
});
