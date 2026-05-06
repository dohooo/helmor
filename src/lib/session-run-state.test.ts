import { describe, expect, it } from "vitest";
import {
	deriveBusySessionIds,
	deriveBusyWorkspaceIds,
	deriveStoppableSessionIds,
	nextSessionRunStates,
	withPendingFinalizeRunState,
} from "./session-run-state";

describe("session run state", () => {
	it("derives session and workspace loading from a single lifecycle map", () => {
		const states = nextSessionRunStates(new Map(), {
			sessionId: "session-1",
			workspaceId: "workspace-1",
			running: true,
		});

		expect(Array.from(deriveBusySessionIds(states))).toEqual(["session-1"]);
		expect(Array.from(deriveBusyWorkspaceIds(states))).toEqual(["workspace-1"]);
		expect(Array.from(deriveStoppableSessionIds(states))).toEqual([
			"session-1",
		]);
	});

	it("keeps pending finalize busy but not stoppable", () => {
		const states = withPendingFinalizeRunState(new Map(), {
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
		const streaming = nextSessionRunStates(new Map(), {
			sessionId: "session-1",
			workspaceId: "workspace-1",
			running: true,
		});
		const states = withPendingFinalizeRunState(streaming, {
			sessionId: "session-1",
			workspaceId: "workspace-1",
		});

		expect(deriveStoppableSessionIds(states).has("session-1")).toBe(true);
	});

	it("removes terminal sessions from derived loading sets", () => {
		const streaming = nextSessionRunStates(new Map(), {
			sessionId: "session-1",
			workspaceId: "workspace-1",
			running: true,
		});
		const states = nextSessionRunStates(streaming, {
			sessionId: "session-1",
			workspaceId: "workspace-1",
			running: false,
		});

		expect(deriveBusySessionIds(states).size).toBe(0);
		expect(deriveBusyWorkspaceIds(states).size).toBe(0);
		expect(deriveStoppableSessionIds(states).size).toBe(0);
	});
});
