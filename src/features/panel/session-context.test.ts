import { describe, expect, it } from "vitest";
import type { WorkspaceSessionSummary } from "@/lib/api";
import { buildSessionContextCandidates } from "./session-context";

function session(
	overrides: Partial<WorkspaceSessionSummary> &
		Pick<WorkspaceSessionSummary, "id">,
): WorkspaceSessionSummary {
	const { id, ...rest } = overrides;
	return {
		id,
		workspaceId: "workspace-1",
		title: id,
		agentType: "claude",
		status: "idle",
		model: null,
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		fastMode: false,
		createdAt: "2026-04-10T00:00:00Z",
		updatedAt: "2026-04-10T00:00:00Z",
		lastUserMessageAt: "2026-04-10T00:00:00Z",
		isHidden: false,
		actionKind: null,
		sessionKind: "gui",
		active: false,
		...rest,
	};
}

describe("buildSessionContextCandidates", () => {
	it("keeps only useful prior GUI sessions and sorts by recent user activity", () => {
		const candidates = buildSessionContextCandidates({
			currentSessionId: "current",
			displayProviderBySessionId: {
				newer: "codex",
				older: "claude",
			},
			sessions: [
				session({ id: "older", lastUserMessageAt: "2026-04-10T01:00:00Z" }),
				session({
					id: "newer",
					lastUserMessageAt: "2026-04-10T03:00:00Z",
				}),
				session({ id: "current", lastUserMessageAt: "2026-04-10T04:00:00Z" }),
				session({ id: "empty", lastUserMessageAt: null }),
				session({ id: "hidden", isHidden: true }),
				session({ id: "terminal", sessionKind: "terminal" }),
			],
		});

		expect(candidates.map((candidate) => candidate.id)).toEqual([
			"newer",
			"older",
		]);
		expect(candidates.map((candidate) => candidate.displayProvider)).toEqual([
			"codex",
			"claude",
		]);
	});
});
