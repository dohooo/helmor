import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	drainMicroWrites,
	isAsleepPayload,
	isCompanionAsleep,
	isQueueableMicroWrite,
	queueMicroWrite,
	resetCompanionAsleepForTests,
	setCompanionAsleep,
	shouldDropWhenAsleep,
	subscribeCompanionAsleep,
} from "./companion-asleep";

describe("companion-asleep", () => {
	beforeEach(() => {
		resetCompanionAsleepForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("recognizes the Worker's typed asleep payload", () => {
		expect(isAsleepPayload({ code: "ContainerAsleep", asleep: true })).toBe(
			true,
		);
		expect(isAsleepPayload({ code: "Unavailable" })).toBe(false);
		expect(isAsleepPayload("nope")).toBe(false);
		expect(isAsleepPayload(null)).toBe(false);
	});

	it("notifies subscribers only on transitions", () => {
		const listener = vi.fn();
		subscribeCompanionAsleep(listener);
		setCompanionAsleep(true);
		setCompanionAsleep(true); // no-op: already asleep
		expect(listener).toHaveBeenCalledTimes(1);
		expect(isCompanionAsleep()).toBe(true);
		setCompanionAsleep(false);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("classifies queueable micro-writes vs drop-when-asleep signals", () => {
		expect(isQueueableMicroWrite("mark_session_read")).toBe(true);
		expect(isQueueableMicroWrite("send_agent_message_stream")).toBe(false);
		expect(shouldDropWhenAsleep("report_presence")).toBe(true);
		expect(shouldDropWhenAsleep("mark_session_read")).toBe(false);
	});

	it("dedupes by semantic slot with last-writer-wins", () => {
		queueMicroWrite("mark_session_read", { sessionId: "a" });
		queueMicroWrite("mark_session_unread", { sessionId: "a" }); // same slot
		queueMicroWrite("mark_session_read", { sessionId: "b" }); // other slot
		const drained = drainMicroWrites();
		expect(drained).toEqual([
			{ cmd: "mark_session_unread", args: { sessionId: "a" } },
			{ cmd: "mark_session_read", args: { sessionId: "b" } },
		]);
		// Drain empties the queue.
		expect(drainMicroWrites()).toEqual([]);
	});

	it("drops the oldest entry (with a warning) on overflow", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < 101; i++) {
			queueMicroWrite("set_session_draft", { sessionId: `s${i}` });
		}
		const drained = drainMicroWrites();
		expect(drained).toHaveLength(100);
		// Oldest (s0) was dropped; newest survives.
		expect(drained[0]).toEqual({
			cmd: "set_session_draft",
			args: { sessionId: "s1" },
		});
		expect(drained.at(-1)).toEqual({
			cmd: "set_session_draft",
			args: { sessionId: "s100" },
		});
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
