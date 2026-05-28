import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetStreamingStoreForTests,
	useStreamingStore,
} from "./streaming-store";

const KEY = "session:abc";

function makePendingUserInput(id = "tool-1") {
	return {
		provider: "claude" as const,
		modelId: "opus",
		resolvedModel: "claude-opus-4",
		providerSessionId: null,
		workingDirectory: "/tmp",
		permissionMode: null,
		userInputId: id,
		source: "Claude",
		message: "",
		payload: {
			kind: "ask-user-question" as const,
			questions: [] as Record<string, unknown>[],
		},
	};
}

describe("useStreamingStore", () => {
	beforeEach(() => {
		__resetStreamingStoreForTests();
	});

	it("emits to listeners only when state actually changes", () => {
		const listener = vi.fn();
		const unsubscribe = useStreamingStore.subscribe(listener);

		useStreamingStore.getState().markSendingState(KEY);
		expect(listener).toHaveBeenCalledTimes(1);

		// no-op: already in sending set
		useStreamingStore.getState().markSendingState(KEY);
		expect(listener).toHaveBeenCalledTimes(1);

		useStreamingStore.getState().clearSendingState(KEY);
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
	});

	it("subscribe returns an unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = useStreamingStore.subscribe(listener);

		useStreamingStore.getState().markSendingState(KEY);
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		useStreamingStore.getState().clearSendingState(KEY);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("keeps reference identity for untouched slices", () => {
		const before = useStreamingStore.getState();

		useStreamingStore
			.getState()
			.setPendingUserInput(KEY, makePendingUserInput());
		const after = useStreamingStore.getState();

		expect(after.pendingPermissionsByContext).toBe(
			before.pendingPermissionsByContext,
		);
		expect(after.sendingContextKeys).toBe(before.sendingContextKeys);
		expect(after.pendingUserInputByContext).not.toBe(
			before.pendingUserInputByContext,
		);
	});

	it("clearPendingUserInput drops both pending and response-pending", () => {
		const store = useStreamingStore.getState();
		store.setPendingUserInput(KEY, makePendingUserInput());
		store.setUserInputResponsePending(KEY, true);

		store.clearPendingUserInput(KEY);

		const s = useStreamingStore.getState();
		expect(s.pendingUserInputByContext[KEY]).toBeUndefined();
		expect(s.userInputResponsePendingByContext[KEY]).toBeUndefined();
	});

	it("appendPendingPermission accumulates", () => {
		const store = useStreamingStore.getState();
		store.appendPendingPermission(KEY, {
			permissionId: "p1",
			toolName: "Bash",
			toolInput: { command: "ls" },
		});
		store.appendPendingPermission(KEY, {
			permissionId: "p2",
			toolName: "Read",
			toolInput: { path: "/foo" },
		});
		expect(
			useStreamingStore.getState().pendingPermissionsByContext[KEY],
		).toHaveLength(2);
	});

	it("removePendingPermission drops one entry; clears the bucket when last", () => {
		const store = useStreamingStore.getState();
		store.appendPendingPermission(KEY, {
			permissionId: "p1",
			toolName: "Bash",
			toolInput: {},
		});
		store.appendPendingPermission(KEY, {
			permissionId: "p2",
			toolName: "Read",
			toolInput: {},
		});

		store.removePendingPermission(KEY, "p1");
		expect(
			useStreamingStore.getState().pendingPermissionsByContext[KEY],
		).toHaveLength(1);

		store.removePendingPermission(KEY, "p2");
		expect(
			useStreamingStore.getState().pendingPermissionsByContext[KEY],
		).toBeUndefined();
	});

	it("removePendingPermission is a no-op when id absent", () => {
		const listener = vi.fn();
		const unsubscribe = useStreamingStore.subscribe(listener);
		useStreamingStore.getState().removePendingPermission(KEY, "ghost");
		expect(listener).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("setLiveSession dedupes equivalent updates", () => {
		const listener = vi.fn();
		const unsubscribe = useStreamingStore.subscribe(listener);

		useStreamingStore.getState().setLiveSession(KEY, {
			provider: "claude",
			providerSessionId: "sid-1",
		});
		expect(listener).toHaveBeenCalledTimes(1);

		useStreamingStore.getState().setLiveSession(KEY, {
			provider: "claude",
			providerSessionId: "sid-1",
		});
		expect(listener).toHaveBeenCalledTimes(1);

		useStreamingStore.getState().setLiveSession(KEY, {
			provider: "claude",
			providerSessionId: "sid-2",
		});
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
	});

	it("rememberInteractionWorkspace dedupes equivalent updates", () => {
		const listener = vi.fn();
		const unsubscribe = useStreamingStore.subscribe(listener);

		useStreamingStore.getState().rememberInteractionWorkspace(KEY, "ws-1");
		expect(listener).toHaveBeenCalledTimes(1);

		useStreamingStore.getState().rememberInteractionWorkspace(KEY, "ws-1");
		expect(listener).toHaveBeenCalledTimes(1);

		useStreamingStore.getState().rememberInteractionWorkspace(KEY, null);
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
	});

	it("survives the canonical pendingUserInput unmount-remount scenario", () => {
		// The bug we are fixing: backend writes to store while UI is
		// unmounted; UI later remounts and reads the existing snapshot.

		// (1) backend writes — no listener attached yet
		useStreamingStore
			.getState()
			.setPendingUserInput(KEY, makePendingUserInput("tool-late"));

		// (2) UI remounts and reads
		const snapshot = useStreamingStore.getState();
		expect(snapshot.pendingUserInputByContext[KEY]).toEqual(
			makePendingUserInput("tool-late"),
		);
	});
});
