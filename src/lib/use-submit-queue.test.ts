// Round6 P1-7b: queued submits are stamped with the transport generation at
// enqueue time, and `popNext` DROPS entries from a previous generation — their
// session/workspace ids belong to the old backend, so draining them into the
// new transport would fire old ids at the wrong backend. The transport-switch
// effect resets the whole queue; this guard covers a drain racing that reset.

import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpTransportGeneration } from "./transport-generation";
import {
	__resetSubmitQueueForTests,
	useSubmitQueueStore,
} from "./use-submit-queue";

const CONTEXT = {
	sessionId: "session-old-backend",
	workspaceId: "workspace-1",
	contextKey: "session:session-old-backend",
};

const PAYLOAD = {
	prompt: "queued follow-up",
	imagePaths: [],
	filePaths: [],
	customTags: [],
	model: { id: "m1", provider: "claude" } as never,
	workingDirectory: "/tmp/helmor",
	effortLevel: "medium",
	permissionMode: "default",
	fastMode: false,
};

afterEach(() => {
	__resetSubmitQueueForTests();
	vi.restoreAllMocks();
});

describe("submit queue transport-generation hygiene (P1-7b)", () => {
	it("popNext drops entries enqueued under a previous transport generation", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const api = useSubmitQueueStore.getState();
		api.enqueue(CONTEXT, PAYLOAD);

		// In-place team↔local switch happens while the entry is still queued.
		bumpTransportGeneration();

		expect(api.popNext(CONTEXT.sessionId)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		// The stale bucket is gone entirely — nothing lingers for a later drain.
		expect(api.getQueue(CONTEXT.sessionId)).toEqual([]);
	});

	it("popNext still pops entries from the CURRENT generation", () => {
		const api = useSubmitQueueStore.getState();
		api.enqueue(CONTEXT, PAYLOAD);

		const popped = api.popNext(CONTEXT.sessionId);
		expect(popped?.payload.prompt).toBe("queued follow-up");
		expect(api.popNext(CONTEXT.sessionId)).toBeUndefined();
	});

	it("a stale head does not shadow fresh entries enqueued after the switch", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const api = useSubmitQueueStore.getState();
		api.enqueue(CONTEXT, { ...PAYLOAD, prompt: "old backend" });
		bumpTransportGeneration();
		api.enqueue(CONTEXT, { ...PAYLOAD, prompt: "new backend" });

		const popped = api.popNext(CONTEXT.sessionId);
		expect(popped?.payload.prompt).toBe("new backend");
		expect(api.popNext(CONTEXT.sessionId)).toBeUndefined();
	});
});
