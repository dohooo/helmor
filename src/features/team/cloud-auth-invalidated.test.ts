import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearCloudAuthInvalidated,
	isCloudAuthInvalidated,
	markCloudAuthInvalidated,
	noteCloudAuthTurnError,
	resetCloudAuthInvalidatedForTests,
	subscribeCloudAuthInvalidated,
} from "./cloud-auth-invalidated";

function enableTeamMode() {
	localStorage.setItem("helmor.team.mode", "1");
	localStorage.setItem("helmor.team.url", "https://team.example.workers.dev");
	localStorage.setItem("helmor.team.token", "member");
}

afterEach(() => {
	resetCloudAuthInvalidatedForTests();
	localStorage.clear();
});

describe("cloud-auth-invalidated flag (DF-R6-C)", () => {
	it("marks, reads, clears per provider and notifies subscribers", () => {
		const listener = vi.fn();
		subscribeCloudAuthInvalidated(listener);

		expect(isCloudAuthInvalidated("codex")).toBe(false);
		expect(markCloudAuthInvalidated("codex")).toBe(true);
		expect(isCloudAuthInvalidated("codex")).toBe(true);
		expect(isCloudAuthInvalidated("claude")).toBe(false);
		// Re-marking an already-set flag reports "not newly set" (dedupes the
		// one-shot notification) and doesn't re-notify subscribers.
		expect(markCloudAuthInvalidated("codex")).toBe(false);
		expect(listener).toHaveBeenCalledTimes(1);

		clearCloudAuthInvalidated("codex");
		expect(isCloudAuthInvalidated("codex")).toBe(false);
		expect(listener).toHaveBeenCalledTimes(2);
	});
});

describe("noteCloudAuthTurnError (DF-R6-C)", () => {
	it("flags the provider, invalidates the identity query, and notifies ONCE", () => {
		enableTeamMode();
		const queryClient = new QueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		const notify = vi.fn();

		noteCloudAuthTurnError({
			message: "stream error: 401 token_invalidated",
			provider: "codex",
			queryClient,
			notify,
		});
		noteCloudAuthTurnError({
			message: "stream error: 401 token_invalidated",
			provider: "codex",
			queryClient,
			notify,
		});

		expect(isCloudAuthInvalidated("codex")).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatch(/codex.*re-authorize/i);
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["cloudCodexIdentity"],
		});
	});

	it("ignores non-auth errors and stays inert outside team mode", () => {
		const queryClient = new QueryClient();
		const notify = vi.fn();

		// Team mode ON, but a non-auth error.
		enableTeamMode();
		noteCloudAuthTurnError({
			message: "Connection reset by peer",
			provider: "codex",
			queryClient,
			notify,
		});
		expect(isCloudAuthInvalidated("codex")).toBe(false);

		// Auth error, but team mode OFF.
		localStorage.clear();
		noteCloudAuthTurnError({
			message: "401 token_invalidated",
			provider: "codex",
			queryClient,
			notify,
		});
		expect(isCloudAuthInvalidated("codex")).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("ignores providers without a cloud identity (e.g. cursor)", () => {
		enableTeamMode();
		const queryClient = new QueryClient();
		const notify = vi.fn();
		noteCloudAuthTurnError({
			message: "401 token_invalidated",
			provider: "cursor",
			queryClient,
			notify,
		});
		expect(isCloudAuthInvalidated("codex")).toBe(false);
		expect(isCloudAuthInvalidated("claude")).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});
});
