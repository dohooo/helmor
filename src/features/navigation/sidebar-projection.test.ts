import { describe, expect, it } from "vitest";
import type { WorkspaceGroup, WorkspaceSummary } from "@/lib/api";
import {
	applySidebarView,
	type PendingArchiveEntry,
	type PendingCreationEntry,
	projectSidebarLists,
	projectVisualSidebar,
	REPO_GROUP_PREFIX,
	regroupByRepo,
	repoIdFromGroupId,
	shouldReconcilePendingArchive,
	shouldReconcilePendingCreation,
} from "./sidebar-projection";

const liveGroups: WorkspaceGroup[] = [
	{
		id: "progress",
		label: "In progress",
		tone: "progress",
		rows: [
			{
				id: "ws-1",
				title: "Workspace 1",
				state: "ready",
				status: "in-progress",
			},
			{
				id: "ws-2",
				title: "Workspace 2",
				state: "ready",
				status: "in-progress",
			},
		],
	},
];

function makeArchivedSummary(id: string): WorkspaceSummary {
	return {
		id,
		title: `Archived ${id}`,
		directoryName: id,
		repoId: "repo-1",
		repoName: "helmor",
		state: "archived",
		hasUnread: false,
		workspaceUnread: 0,
		unreadSessionCount: 0,
		status: "in-progress",
		branch: null,
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		prTitle: null,
		pinnedAt: null,
		sessionCount: 0,
		messageCount: 0,
		createdAt: "2024-01-01T00:00:00Z",
	};
}

function makePendingArchive(
	workspaceId: string,
	sortTimestamp: number,
): PendingArchiveEntry {
	return {
		row: {
			id: workspaceId,
			title: `Workspace ${workspaceId}`,
			state: "archived",
			status: "in-progress",
		},
		sourceGroupId: "progress",
		sourceIndex: 0,
		stage: "running",
		sortTimestamp,
	};
}

function makePendingCreation(
	workspaceId: string,
	resolvedWorkspaceId: string | null = null,
): PendingCreationEntry {
	return {
		repoId: "repo-1",
		row: {
			id: resolvedWorkspaceId ?? workspaceId,
			title: "Creating helmor",
			state: "initializing",
			status: "in-progress",
		},
		stage: resolvedWorkspaceId ? "confirmed" : "creating",
		resolvedWorkspaceId,
	};
}

describe("projectSidebarLists", () => {
	it("keeps a pending archived workspace out of live groups even before server reconciliation", () => {
		const projected = projectSidebarLists({
			baseGroups: liveGroups,
			baseArchivedSummaries: [],
			pendingArchives: new Map([["ws-1", makePendingArchive("ws-1", 100)]]),
			pendingCreations: new Map(),
		});

		expect(projected.groups[0]?.rows.map((row) => row.id)).toEqual(["ws-2"]);
		expect(projected.archivedRows.map((row) => row.id)).toEqual(["ws-1"]);
	});

	it("dedupes a workspace once the server snapshot also contains it in archived", () => {
		const projected = projectSidebarLists({
			baseGroups: liveGroups,
			baseArchivedSummaries: [makeArchivedSummary("ws-1")],
			pendingArchives: new Map([["ws-1", makePendingArchive("ws-1", 100)]]),
			pendingCreations: new Map(),
		});

		expect(projected.groups[0]?.rows.map((row) => row.id)).toEqual(["ws-2"]);
		expect(projected.archivedRows.map((row) => row.id)).toEqual(["ws-1"]);
	});

	it("sorts optimistic archived placeholders by their latest archive timestamp", () => {
		const projected = projectSidebarLists({
			baseGroups: liveGroups,
			baseArchivedSummaries: [],
			pendingArchives: new Map([
				["ws-1", makePendingArchive("ws-1", 100)],
				["ws-2", makePendingArchive("ws-2", 200)],
			]),
			pendingCreations: new Map(),
		});

		expect(projected.archivedRows.map((row) => row.id)).toEqual([
			"ws-2",
			"ws-1",
		]);
	});

	it("shows a pending creation as a single projected row even after the real workspace appears", () => {
		const projected = projectSidebarLists({
			baseGroups: [
				{
					...liveGroups[0],
					rows: [
						{
							id: "ws-created",
							title: "Workspace created",
							state: "initializing",
							status: "in-progress",
						},
						...liveGroups[0].rows,
					],
				},
			],
			baseArchivedSummaries: [],
			pendingArchives: new Map(),
			pendingCreations: new Map([
				[
					"creating-workspace:repo-1:1",
					makePendingCreation("creating-workspace:repo-1:1", "ws-created"),
				],
			]),
		});

		expect(
			projected.groups[0]?.rows.filter((row) => row.id === "ws-created"),
		).toHaveLength(1);
	});
});

describe("shouldReconcilePendingArchive", () => {
	it("waits until the workspace leaves live groups and appears in archived", () => {
		expect(
			shouldReconcilePendingArchive("ws-1", liveGroups, [
				makeArchivedSummary("ws-1"),
			]),
		).toBe(false);
		expect(
			shouldReconcilePendingArchive(
				"ws-1",
				[{ ...liveGroups[0], rows: [] }],
				[],
			),
		).toBe(false);
		expect(
			shouldReconcilePendingArchive(
				"ws-1",
				[{ ...liveGroups[0], rows: [] }],
				[makeArchivedSummary("ws-1")],
			),
		).toBe(true);
	});
});

describe("shouldReconcilePendingCreation", () => {
	it("waits until the confirmed workspace appears in live groups", () => {
		expect(
			shouldReconcilePendingCreation(
				makePendingCreation("creating-workspace:repo-1:1"),
				liveGroups,
			),
		).toBe(false);
		expect(
			shouldReconcilePendingCreation(
				makePendingCreation("creating-workspace:repo-1:1", "ws-created"),
				liveGroups,
			),
		).toBe(false);
		expect(
			shouldReconcilePendingCreation(
				makePendingCreation("creating-workspace:repo-1:1", "ws-created"),
				[
					{
						...liveGroups[0],
						rows: [
							{
								id: "ws-created",
								title: "Workspace created",
								state: "initializing",
								status: "in-progress",
							},
						],
					},
				],
			),
		).toBe(true);
	});
});

describe("regroupByRepo", () => {
	const fixture: WorkspaceGroup[] = [
		{
			id: "pinned",
			label: "Pinned",
			tone: "pinned",
			rows: [
				{
					id: "ws-pinned",
					title: "Pinned ws",
					state: "ready",
					status: "in-progress",
					repoId: "repo-A",
					repoName: "alpha",
				},
			],
		},
		{
			id: "progress",
			label: "In progress",
			tone: "progress",
			rows: [
				{
					id: "ws-progress",
					title: "In flight",
					state: "initializing",
					status: "in-progress",
					repoId: "repo-A",
					repoName: "alpha",
				},
			],
		},
		{
			id: "done",
			label: "Done",
			tone: "done",
			rows: [
				{
					id: "ws-done-A",
					title: "Done A",
					state: "ready",
					status: "done",
					repoId: "repo-A",
					repoName: "alpha",
				},
				{
					id: "ws-done-B",
					title: "Done B",
					state: "ready",
					status: "done",
					repoId: "repo-B",
					repoName: "beta",
				},
			],
		},
		{
			id: "review",
			label: "In review",
			tone: "review",
			rows: [
				{
					id: "ws-review-A",
					title: "Review A",
					state: "ready",
					status: "review",
					repoId: "repo-A",
					repoName: "alpha",
				},
			],
		},
		{
			id: "backlog",
			label: "Backlog",
			tone: "backlog",
			rows: [
				{
					id: "ws-backlog-A",
					title: "Backlog A",
					state: "ready",
					status: "backlog",
					repoId: "repo-A",
					repoName: "alpha",
				},
			],
		},
	];

	it("keeps pinned at the front and backlog at the back; repo buckets in between", () => {
		const result = regroupByRepo(fixture);
		expect(result.map((g) => g.id)).toEqual([
			"pinned",
			`${REPO_GROUP_PREFIX}repo-A`,
			`${REPO_GROUP_PREFIX}repo-B`,
			"backlog",
		]);
		expect(result[0]?.label).toBe("Pinned");
		expect(result[3]?.label).toBe("Backlog");
	});

	it("buckets non-pinned/non-backlog rows by repoId, label = repoName", () => {
		const result = regroupByRepo(fixture);
		const repoGroups = result.filter((g) => g.id.startsWith(REPO_GROUP_PREFIX));
		expect(repoGroups.map((g) => g.label)).toEqual(["alpha", "beta"]);
		// progress (pendingCreation) + done + review rows for repo-A
		// collapse into the alpha bucket. Pinned and backlog rows do NOT
		// land here — they kept their own groups.
		expect(repoGroups[0]?.rows.map((r) => r.id)).toEqual([
			"ws-progress",
			"ws-done-A",
			"ws-review-A",
		]);
		expect(repoGroups[1]?.rows.map((r) => r.id)).toEqual(["ws-done-B"]);
	});

	it("sorts rows inside a repo bucket by displayOrder", () => {
		const result = regroupByRepo([
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						id: "ws-late",
						title: "Late",
						state: "ready",
						status: "in-progress",
						repoId: "repo-A",
						repoName: "alpha",
						displayOrder: 2000,
					},
					{
						id: "ws-early",
						title: "Early",
						state: "ready",
						status: "in-progress",
						repoId: "repo-A",
						repoName: "alpha",
						displayOrder: 1000,
					},
				],
			},
		]);

		expect(result[0]?.rows.map((row) => row.id)).toEqual([
			"ws-early",
			"ws-late",
		]);
	});

	it("collects rows missing repoId into a single Unknown bucket", () => {
		const result = regroupByRepo([
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [
					{
						id: "ws-orphan-1",
						title: "Orphan 1",
						state: "ready",
						status: "done",
					},
					{
						id: "ws-orphan-2",
						title: "Orphan 2",
						state: "ready",
						status: "done",
					},
				],
			},
		]);
		expect(result).toHaveLength(1);
		expect(result[0]?.id.startsWith(REPO_GROUP_PREFIX)).toBe(true);
		expect(result[0]?.label).toBe("Unknown");
		expect(result[0]?.rows.map((r) => r.id)).toEqual([
			"ws-orphan-1",
			"ws-orphan-2",
		]);
	});
});

describe("projectVisualSidebar", () => {
	const baseGroups: WorkspaceGroup[] = [
		{
			id: "progress",
			label: "In progress",
			tone: "progress",
			rows: [
				{
					id: "ws-a",
					title: "A",
					state: "ready",
					status: "in-progress",
					repoId: "repo-1",
					repoName: "repo-one",
				},
				{
					id: "ws-b",
					title: "B",
					state: "ready",
					status: "in-progress",
					repoId: "repo-2",
					repoName: "repo-two",
				},
			],
		},
	];

	it("returns the projection unchanged when grouping is `status`", () => {
		const result = projectVisualSidebar(
			{
				baseGroups,
				baseArchivedSummaries: [],
				pendingArchives: new Map(),
				pendingCreations: new Map(),
			},
			"status",
		);
		// Status mode: rows stay in their original status bucket.
		expect(result.groups.map((g) => g.id)).toEqual(["progress"]);
		expect(result.groups[0]?.rows.map((r) => r.id)).toEqual(["ws-a", "ws-b"]);
	});

	it("re-buckets the projection by repo when grouping is `repo`", () => {
		const result = projectVisualSidebar(
			{
				baseGroups,
				baseArchivedSummaries: [],
				pendingArchives: new Map(),
				pendingCreations: new Map(),
			},
			"repo",
		);
		// Repo mode: rows flatten out of `progress` and bucket per repoId.
		expect(result.groups.map((g) => g.id)).toEqual([
			`${REPO_GROUP_PREFIX}repo-1`,
			`${REPO_GROUP_PREFIX}repo-2`,
		]);
		expect(result.groups[0]?.rows.map((r) => r.id)).toEqual(["ws-a"]);
		expect(result.groups[1]?.rows.map((r) => r.id)).toEqual(["ws-b"]);
	});

	it("hides pending-archived rows in both grouping modes", () => {
		// Same `pendingArchives` should drop ws-a from live groups regardless
		// of grouping — the projection-then-regroup composition has to apply
		// pendingArchives BEFORE regroupByRepo, otherwise the row leaks into
		// the repo bucket.
		const args = {
			baseGroups,
			baseArchivedSummaries: [],
			pendingArchives: new Map([
				[
					"ws-a",
					{
						row: { id: "ws-a", title: "A", state: "archived", status: null },
						sourceGroupId: "progress",
						sourceIndex: 0,
						stage: "running",
						sortTimestamp: 1,
					},
				],
			]) as unknown as Map<string, PendingArchiveEntry>,
			pendingCreations: new Map<string, PendingCreationEntry>(),
		};

		const status = projectVisualSidebar(args, "status");
		expect(status.groups.flatMap((g) => g.rows.map((r) => r.id))).not.toContain(
			"ws-a",
		);

		const repo = projectVisualSidebar(args, "repo");
		expect(repo.groups.flatMap((g) => g.rows.map((r) => r.id))).not.toContain(
			"ws-a",
		);
		// The "ws-a" pending row surfaces only in archivedRows, identical
		// for both groupings.
		expect(repo.archivedRows.map((r) => r.id)).toEqual(["ws-a"]);
		expect(status.archivedRows.map((r) => r.id)).toEqual(["ws-a"]);
	});
});

describe("applySidebarView", () => {
	const projected = {
		groups: [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						id: "ws-beta-old",
						title: "Beta old",
						state: "ready",
						repoId: "repo-beta",
						repoName: "Beta",
						createdAt: "2024-01-01T00:00:00Z",
						updatedAt: "2024-01-03T00:00:00Z",
					},
					{
						id: "ws-alpha-new",
						title: "Alpha new",
						state: "ready",
						repoId: "repo-alpha",
						repoName: "Alpha",
						createdAt: "2024-01-04T00:00:00Z",
						updatedAt: "2024-01-02T00:00:00Z",
					},
				],
			},
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [
					{
						id: "ws-gamma",
						title: "Gamma",
						state: "ready",
						repoId: "repo-gamma",
						repoName: "Gamma",
						createdAt: "2024-01-02T00:00:00Z",
						updatedAt: "2024-01-05T00:00:00Z",
					},
				],
			},
		],
		archivedRows: [
			{
				id: "ws-archived-alpha",
				title: "Archived alpha",
				state: "archived",
				repoId: "repo-alpha",
				repoName: "Alpha",
				createdAt: "2024-01-05T00:00:00Z",
				updatedAt: "2024-01-06T00:00:00Z",
			},
			{
				id: "ws-archived-beta",
				title: "Archived beta",
				state: "archived",
				repoId: "repo-beta",
				repoName: "Beta",
				createdAt: "2024-01-06T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
			},
		],
	} satisfies ReturnType<typeof projectSidebarLists>;

	it("filters live and archived rows by multiple repositories", () => {
		const result = applySidebarView(projected, {
			repoFilterIds: ["repo-alpha", "repo-gamma"],
			sort: "custom",
		});

		expect(result.groups.map((group) => group.id)).toEqual([
			"progress",
			"done",
		]);
		expect(
			result.groups.flatMap((group) => group.rows.map((row) => row.id)),
		).toEqual(["ws-alpha-new", "ws-gamma"]);
		expect(result.archivedRows.map((row) => row.id)).toEqual([
			"ws-archived-alpha",
		]);
	});

	it("ignores stale persisted repository ids", () => {
		const result = applySidebarView(projected, {
			repoFilterIds: ["repo-missing"],
			sort: "custom",
		});

		expect(
			result.groups.flatMap((group) => group.rows.map((row) => row.id)),
		).toEqual(["ws-beta-old", "ws-alpha-new", "ws-gamma"]);
	});

	it("keeps a known empty repository filter active", () => {
		const result = applySidebarView(projected, {
			availableRepoIds: ["repo-empty"],
			repoFilterIds: ["repo-empty"],
			sort: "custom",
		});

		expect(result.groups.map((group) => [group.id, group.rows])).toEqual([
			["progress", []],
			["done", []],
		]);
		expect(result.archivedRows).toEqual([]);
	});

	it("keeps empty status drop targets while filtering", () => {
		const result = applySidebarView(
			{
				groups: [
					{
						id: "pinned",
						label: "Pinned",
						tone: "pinned",
						rows: [],
					},
					{
						id: "progress",
						label: "In progress",
						tone: "progress",
						rows: [
							{
								id: "ws-alpha",
								title: "Alpha",
								state: "ready",
								repoId: "repo-alpha",
								repoName: "Alpha",
							},
						],
					},
					{
						id: "review",
						label: "In review",
						tone: "review",
						rows: [],
					},
					{
						id: "backlog",
						label: "Backlog",
						tone: "backlog",
						rows: [],
					},
				],
				archivedRows: [],
			},
			{ repoFilterIds: ["repo-alpha"], sort: "custom" },
		);

		expect(result.groups.map((group) => group.id)).toEqual([
			"pinned",
			"progress",
			"review",
			"backlog",
		]);
	});

	it("removes empty repo buckets while keeping pinned and backlog drop targets", () => {
		const result = applySidebarView(
			{
				groups: [
					{ id: "pinned", label: "Pinned", tone: "pinned", rows: [] },
					{
						id: `${REPO_GROUP_PREFIX}repo-alpha`,
						label: "Alpha",
						tone: "pinned",
						rows: [
							{
								id: "ws-alpha",
								title: "Alpha",
								state: "ready",
								repoId: "repo-alpha",
								repoName: "Alpha",
							},
						],
					},
					{
						id: `${REPO_GROUP_PREFIX}repo-beta`,
						label: "Beta",
						tone: "pinned",
						rows: [
							{
								id: "ws-beta",
								title: "Beta",
								state: "ready",
								repoId: "repo-beta",
								repoName: "Beta",
							},
						],
					},
					{ id: "backlog", label: "Backlog", tone: "backlog", rows: [] },
				],
				archivedRows: [],
			},
			{ repoFilterIds: ["repo-alpha"], sort: "custom" },
		);

		expect(result.groups.map((group) => group.id)).toEqual([
			"pinned",
			`${REPO_GROUP_PREFIX}repo-alpha`,
			"backlog",
		]);
	});

	it("keeps custom order unchanged", () => {
		const result = applySidebarView(projected, { sort: "custom" });

		expect(result.groups[0]?.rows.map((row) => row.id)).toEqual([
			"ws-beta-old",
			"ws-alpha-new",
		]);
	});

	it("sorts rows by repository name", () => {
		const result = applySidebarView(projected, { sort: "repoName" });

		expect(result.groups[0]?.rows.map((row) => row.id)).toEqual([
			"ws-alpha-new",
			"ws-beta-old",
		]);
	});

	it("sorts rows by last updated and created time newest first", () => {
		const byUpdated = applySidebarView(projected, { sort: "updatedAt" });
		const byCreated = applySidebarView(projected, { sort: "createdAt" });

		expect(byUpdated.groups[0]?.rows.map((row) => row.id)).toEqual([
			"ws-beta-old",
			"ws-alpha-new",
		]);
		expect(byCreated.groups[0]?.rows.map((row) => row.id)).toEqual([
			"ws-alpha-new",
			"ws-beta-old",
		]);
	});

	it("keeps status groups in semantic order while sorting rows inside them", () => {
		const result = applySidebarView(
			{
				groups: [
					{
						id: "done",
						label: "Done",
						tone: "done",
						rows: [
							projected.groups[0]!.rows[0]!,
							projected.groups[0]!.rows[1]!,
						],
					},
					{
						id: "review",
						label: "In review",
						tone: "review",
						rows: [projected.groups[1]!.rows[0]!],
					},
					{
						id: "progress",
						label: "In progress",
						tone: "progress",
						rows: [],
					},
					{
						id: "backlog",
						label: "Backlog",
						tone: "backlog",
						rows: [],
					},
					{
						id: "canceled",
						label: "Canceled",
						tone: "canceled",
						rows: [],
					},
				],
				archivedRows: [],
			},
			{ sort: "repoName" },
		);

		expect(result.groups.map((group) => group.id)).toEqual([
			"done",
			"review",
			"progress",
			"backlog",
			"canceled",
		]);
		expect(result.groups[0]?.rows.map((row) => row.id)).toEqual([
			"ws-alpha-new",
			"ws-beta-old",
		]);
	});

	it("sorts repo buckets without moving pinned and backlog sections", () => {
		const result = applySidebarView(
			{
				groups: [
					{ id: "pinned", label: "Pinned", tone: "pinned", rows: [] },
					{
						id: `${REPO_GROUP_PREFIX}repo-beta`,
						label: "Beta",
						tone: "pinned",
						rows: [projected.groups[0]!.rows[0]!],
					},
					{
						id: `${REPO_GROUP_PREFIX}repo-alpha`,
						label: "Alpha",
						tone: "pinned",
						rows: [projected.groups[0]!.rows[1]!],
					},
					{ id: "backlog", label: "Backlog", tone: "backlog", rows: [] },
				],
				archivedRows: [],
			},
			{ sort: "repoName" },
		);

		expect(result.groups.map((group) => group.id)).toEqual([
			"pinned",
			`${REPO_GROUP_PREFIX}repo-alpha`,
			`${REPO_GROUP_PREFIX}repo-beta`,
			"backlog",
		]);
	});

	it("always sorts archived rows by updatedAt DESC regardless of sidebarSort", () => {
		// Same archived input under each sort key should produce the same
		// order — newest updatedAt first. Custom/repoName/createdAt all
		// must not leak into the archived section.
		const expectedArchivedOrder = ["ws-archived-alpha", "ws-archived-beta"];
		for (const sort of [
			"custom",
			"repoName",
			"updatedAt",
			"createdAt",
		] as const) {
			const result = applySidebarView(projected, { sort });
			expect(result.archivedRows.map((row) => row.id)).toEqual(
				expectedArchivedOrder,
			);
		}
	});
});

describe("repoIdFromGroupId", () => {
	it("returns the underlying repo id for a real repo bucket", () => {
		expect(repoIdFromGroupId(`${REPO_GROUP_PREFIX}repo-123`)).toBe("repo-123");
	});

	it("returns null for the unknown-repo bucket", () => {
		expect(repoIdFromGroupId(`${REPO_GROUP_PREFIX}__unknown__`)).toBeNull();
	});

	it("returns null for status / pinned / backlog group ids", () => {
		expect(repoIdFromGroupId("progress")).toBeNull();
		expect(repoIdFromGroupId("pinned")).toBeNull();
		expect(repoIdFromGroupId("backlog")).toBeNull();
	});
});
