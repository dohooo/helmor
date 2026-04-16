import { describe, expect, it } from "vitest";
import type { WorkspaceSessionSummary } from "@/lib/api";
import { sortWorkspaceSessionsForDisplay } from "./session-sort";

function createSession(
	id: string,
	overrides: Partial<WorkspaceSessionSummary> = {},
): WorkspaceSessionSummary {
	return {
		id,
		workspaceId: "workspace-1",
		title: id,
		agentType: "claude",
		status: "idle",
		model: "opus",
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		contextTokenCount: 0,
		contextUsedPercent: null,
		thinkingEnabled: true,
		fastMode: false,
		agentPersonality: null,
		createdAt: "2026-04-10T00:00:00Z",
		updatedAt: "2026-04-10T00:00:00Z",
		lastUserMessageAt: null,
		resumeSessionAt: null,
		isHidden: false,
		isCompacting: false,
		actionKind: null,
		active: false,
		...overrides,
	};
}

describe("sortWorkspaceSessionsForDisplay", () => {
	it("prioritizes non-action attention sessions, then running, then idle, then actions", () => {
		const sessions = [
			createSession("action-idle", {
				actionKind: "create-pr",
				updatedAt: "2026-04-10T00:00:00Z",
			}),
			createSession("idle", {
				updatedAt: "2026-04-11T00:00:00Z",
			}),
			createSession("running", {
				status: "running",
				updatedAt: "2026-04-12T00:00:00Z",
			}),
			createSession("unread", {
				unreadCount: 2,
				updatedAt: "2026-04-09T00:00:00Z",
			}),
			createSession("action-running", {
				actionKind: "commit-and-push",
				status: "running",
				updatedAt: "2026-04-13T00:00:00Z",
			}),
		];

		expect(
			sortWorkspaceSessionsForDisplay(sessions).map((session) => session.id),
		).toEqual(["unread", "running", "idle", "action-running", "action-idle"]);
	});

	it("keeps interaction-required ahead of unread and completed within the attention group", () => {
		const sessions = [
			createSession("completed", {
				updatedAt: "2026-04-10T00:00:00Z",
			}),
			createSession("unread", {
				unreadCount: 1,
				updatedAt: "2026-04-11T00:00:00Z",
			}),
			createSession("needs-input", {
				updatedAt: "2026-04-09T00:00:00Z",
			}),
		];

		expect(
			sortWorkspaceSessionsForDisplay(sessions, {
				completedSessionIds: new Set(["completed"]),
				interactionRequiredSessionIds: new Set(["needs-input"]),
			}).map((session) => session.id),
		).toEqual(["needs-input", "unread", "completed"]);
	});

	it("uses updatedAt descending as the tie-breaker within the same group", () => {
		const sessions = [
			createSession("older", {
				updatedAt: "2026-04-10T00:00:00Z",
			}),
			createSession("newer", {
				updatedAt: "2026-04-12T00:00:00Z",
			}),
		];

		expect(
			sortWorkspaceSessionsForDisplay(sessions).map((session) => session.id),
		).toEqual(["newer", "older"]);
	});
});
