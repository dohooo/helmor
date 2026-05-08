import { describe, expect, it } from "vitest";
import {
	buildSessionRunStates,
	deriveBusySessionIds,
	deriveBusyWorkspaceIds,
	deriveStoppableSessionIds,
} from "./session-run-state";

describe("session run state", () => {
	it("derives session and workspace busy sets from active streams", () => {
		const states = buildSessionRunStates(
			[
				{
					sessionId: "session-1",
					workspaceId: "workspace-1",
					provider: "claude",
				},
			],
			null,
		);

		expect(Array.from(deriveBusySessionIds(states))).toEqual(["session-1"]);
		expect(Array.from(deriveBusyWorkspaceIds(states))).toEqual(["workspace-1"]);
		expect(Array.from(deriveStoppableSessionIds(states))).toEqual([
			"session-1",
		]);
	});

	it("keeps pending finalize busy but not stoppable", () => {
		const states = buildSessionRunStates([], {
			sessionId: "session-pending",
			workspaceId: "workspace-pending",
		});

		expect(deriveBusySessionIds(states).has("session-pending")).toBe(true);
		expect(deriveBusyWorkspaceIds(states).has("workspace-pending")).toBe(true);
		expect(deriveStoppableSessionIds(states).has("session-pending")).toBe(
			false,
		);
	});

	it("does not let pending finalize downgrade an already streaming session", () => {
		const states = buildSessionRunStates(
			[
				{
					sessionId: "session-1",
					workspaceId: "workspace-1",
					provider: "claude",
				},
			],
			{ sessionId: "session-1", workspaceId: "workspace-1" },
		);

		expect(deriveStoppableSessionIds(states).has("session-1")).toBe(true);
	});

	it("removes terminal sessions when active streams clears", () => {
		const initial = buildSessionRunStates(
			[
				{
					sessionId: "session-1",
					workspaceId: "workspace-1",
					provider: "claude",
				},
			],
			null,
		);
		expect(initial.size).toBe(1);

		const cleared = buildSessionRunStates([], null);
		expect(deriveBusySessionIds(cleared).size).toBe(0);
		expect(deriveBusyWorkspaceIds(cleared).size).toBe(0);
		expect(deriveStoppableSessionIds(cleared).size).toBe(0);
	});

	it("ignores a workspace_id of null on a streaming session for the busy-workspace set", () => {
		const states = buildSessionRunStates(
			[{ sessionId: "session-1", workspaceId: null, provider: "claude" }],
			null,
		);
		expect(deriveBusySessionIds(states).has("session-1")).toBe(true);
		expect(deriveBusyWorkspaceIds(states).size).toBe(0);
	});
});
