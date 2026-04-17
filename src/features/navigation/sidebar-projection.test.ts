import { describe, expect, it } from "vitest";
import type { WorkspaceGroup, WorkspaceSummary } from "@/lib/api";
import {
	type PendingArchiveEntry,
	type PendingCreationEntry,
	projectSidebarLists,
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
				derivedStatus: "in-progress",
			},
			{
				id: "ws-2",
				title: "Workspace 2",
				state: "ready",
				derivedStatus: "in-progress",
			},
		],
	},
];

function makeArchivedSummary(id: string): WorkspaceSummary {
	return {
		id,
		title: `Archived ${id}`,
		directoryName: id,
		repoName: "helmor",
		state: "archived",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "in-progress",
		manualStatus: null,
		branch: null,
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		prTitle: null,
		sessionCount: 0,
		messageCount: 0,
		attachmentCount: 0,
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
			derivedStatus: "in-progress",
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
			derivedStatus: "in-progress",
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
							derivedStatus: "in-progress",
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
								derivedStatus: "in-progress",
							},
						],
					},
				],
			),
		).toBe(true);
	});
});
