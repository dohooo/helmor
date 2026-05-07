import { describe, expect, it } from "vitest";
import type { WorkspaceSessionSummary } from "@/lib/api";
import { shouldConfirmRunningSessionClose } from "./close-guard";

const baseSession: WorkspaceSessionSummary = {
	id: "session-1",
	workspaceId: "workspace-1",
	title: "Session 1",
	agentType: "claude",
	status: "idle",
	model: "opus",
	permissionMode: "default",
	providerSessionId: null,
	effortLevel: null,
	unreadCount: 0,
	fastMode: false,
	createdAt: "2026-04-10T00:00:00Z",
	updatedAt: "2026-04-10T00:00:00Z",
	lastUserMessageAt: null,
	isHidden: false,
	actionKind: null,
	active: true,
};

describe("shouldConfirmRunningSessionClose", () => {
	it("treats persisted streaming sessions as running", () => {
		expect(
			shouldConfirmRunningSessionClose({
				...baseSession,
				status: "streaming",
			}),
		).toBe(true);
	});
});
