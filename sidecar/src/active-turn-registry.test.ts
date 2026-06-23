import { describe, expect, test } from "bun:test";
import { ActiveTurnRegistry } from "./active-turn-registry.js";
import type { SidecarEmitter } from "./emitter.js";

function recordingEmitter() {
	const aborted: Array<{ requestId: string; reason: string }> = [];
	const ended: string[] = [];
	const errors: Array<{ requestId: string; message: string }> = [];
	const emitter = {
		aborted: (requestId: string, reason: string) =>
			aborted.push({ requestId, reason }),
		end: (requestId: string) => ended.push(requestId),
		error: (requestId: string, message: string) =>
			errors.push({ requestId, message }),
	} as unknown as SidecarEmitter;
	return { emitter, aborted, ended, errors };
}

describe("ActiveTurnRegistry", () => {
	// Regression: Stop turn A → queue drains → follow-up turn B re-registers
	// under the same session while A is still unwinding → A's lagging
	// `end()` must NOT evict B, or B's Stop silently no-ops ("停不下来").
	test("end() is requestId-guarded so a lagging aborted turn keeps the follow-up's slot", () => {
		const SID = "session-1";
		const registry = new ActiveTurnRegistry();

		const a = recordingEmitter();
		let aTornDown = 0;
		registry.begin(SID, "req-a", a.emitter, () => aTornDown++);
		expect(registry.requestStop(SID)).toBe(true);
		expect(a.aborted).toEqual([
			{ requestId: "req-a", reason: "user_requested" },
		]);
		expect(aTornDown).toBe(1);

		// Follow-up turn B re-claims the slot before A's finally runs.
		const b = recordingEmitter();
		let bTornDown = 0;
		registry.begin(SID, "req-b", b.emitter, () => bTornDown++);

		// A's lagging cleanup — guarded, so it leaves B alone.
		registry.end(SID, "req-a");

		// Stop on B now reaches B.
		expect(registry.requestStop(SID)).toBe(true);
		expect(b.aborted).toEqual([
			{ requestId: "req-b", reason: "user_requested" },
		]);
		expect(bTornDown).toBe(1);

		// B's own cleanup clears the slot.
		registry.end(SID, "req-b");
		expect(registry.requestStop(SID)).toBe(false);
	});

	test("end() with the owning requestId clears the slot", () => {
		const SID = "session-2";
		const registry = new ActiveTurnRegistry();
		const t = recordingEmitter();
		registry.begin(SID, "req-1", t.emitter, () => {});
		registry.end(SID, "req-1");
		expect(registry.isAbortRequested(SID)).toBe(false);
		expect(registry.requestStop(SID)).toBe(false);
	});

	test("activeSessionIds lists every live turn", () => {
		const registry = new ActiveTurnRegistry();
		expect(registry.activeSessionIds()).toEqual([]);
		registry.begin("s1", "r1", recordingEmitter().emitter, () => {});
		registry.begin("s2", "r2", recordingEmitter().emitter, () => {});
		expect(registry.activeSessionIds().sort()).toEqual(["s1", "s2"]);
		registry.end("s1", "r1");
		expect(registry.activeSessionIds()).toEqual(["s2"]);
	});

	// Backs the #868 cascade fix: a worker-fatal scoped to one session must
	// fail ONLY that session's turn and leave siblings streaming.
	test("failOne fails only the target session and leaves siblings live", () => {
		const registry = new ActiveTurnRegistry();
		const a = recordingEmitter();
		const b = recordingEmitter();
		registry.begin("s1", "r1", a.emitter, () => {});
		registry.begin("s2", "r2", b.emitter, () => {});

		expect(registry.failOne("s1", "boom")).toBe("r1");
		expect(a.errors).toEqual([{ requestId: "r1", message: "boom" }]);
		expect(a.ended).toEqual(["r1"]);
		// Sibling untouched and still live.
		expect(b.errors).toEqual([]);
		expect(registry.activeSessionIds()).toEqual(["s2"]);
	});

	test("failOne is a no-op when the session has no live turn", () => {
		const registry = new ActiveTurnRegistry();
		expect(registry.failOne("ghost", "boom")).toBeNull();
	});
});
