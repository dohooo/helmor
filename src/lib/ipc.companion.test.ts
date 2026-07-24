import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the companion transport's auth-state tracking (src/lib/ipc.ts).
// A browser with no — or a stale/revoked — pairing token must surface as
// "unauthed" so the shell renders the pairing screen instead of falling
// through to the onboarding flow (which shows demo workspaces).
//
// `isTauriRuntime()` is false under jsdom (no `__TAURI_INTERNALS__`), so setting
// `window.__HELMOR_COMPANION__` flips the module onto the HTTP/fetch path.
// `vi.resetModules()` re-evaluates the module-level `COMPANION` const per test.
describe("companion auth state", () => {
	const TOKEN_KEY = "helmor.companion.pat";
	type CompanionWindow = { __HELMOR_COMPANION__?: unknown };

	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState(null, "", "/");
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = {
			base: "https://companion.test",
		};
	});

	afterEach(() => {
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = undefined;
		vi.unstubAllGlobals();
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState(null, "", "/");
	});

	it("is unauthed at boot when no pairing token is stored", async () => {
		const ipc = await import("./ipc");
		expect(ipc.getCompanionAuthState()).toBe("unauthed");
	});

	it("stages a scanned #pair= token but keeps it in the URL for Add to Home Screen", async () => {
		window.location.hash = "#pair=hlm_scanned";
		const ipc = await import("./ipc");
		// The token is staged for the confirm screen...
		expect(ipc.getPendingPairingToken()).toBe("hlm_scanned");
		// ...but is NOT yet the active credential (no silent auto-pairing).
		expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
		expect(ipc.getCompanionAuthState()).toBe("unauthed");
		// The token stays in the URL so the user can save it to the home screen
		// before confirming; it's consumed only on confirm.
		expect(window.location.hash).toContain("pair=hlm_scanned");
	});

	it("skips confirm and consumes the hash when already paired with that token", async () => {
		// Re-opening a saved home-screen shortcut whose URL carries a token we've
		// already paired with must go straight in, not re-prompt.
		localStorage.setItem(TOKEN_KEY, "hlm_known");
		window.location.hash = "#pair=hlm_known";
		const ipc = await import("./ipc");
		expect(ipc.getPendingPairingToken()).toBeNull();
		expect(window.location.hash).toBe("");
	});

	it("flips to unauthed when a request returns 401", async () => {
		localStorage.setItem(TOKEN_KEY, "hlm_stale");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: async () => "unauthorized",
			}),
		);

		const ipc = await import("./ipc");
		// A token is present but not yet verified against the server.
		expect(ipc.getCompanionAuthState()).toBe("unknown");

		await expect(ipc.invoke("list_workspace_groups")).rejects.toBeDefined();
		expect(ipc.getCompanionAuthState()).toBe("unauthed");
	});

	it("reports ok after a successful request and notifies subscribers", async () => {
		localStorage.setItem(TOKEN_KEY, "hlm_valid");
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ groups: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		await ipc.invoke("list_workspace_groups");
		expect(ipc.getCompanionAuthState()).toBe("ok");

		// A later 401 transition fires subscribers (drives the shell re-render).
		const listener = vi.fn();
		const unsub = ipc.subscribeCompanionAuth(listener);
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => "unauthorized",
		});
		await expect(ipc.invoke("list_workspace_groups")).rejects.toBeDefined();
		expect(listener).toHaveBeenCalled();
		expect(ipc.getCompanionAuthState()).toBe("unauthed");
		unsub();
	});
});

// Reconnect resilience for the shared `/v1/stream` SSE channel. A sleeping team
// sandbox cold-starts on the next request (the Worker blocks the fetch ~120s
// while it restores from R2 + serves), so the channel must keep retrying with a
// jittered exponential backoff and surface a "reconnecting" *loading* state —
// never an error, never giving up.
describe("companion connection state + reconnect backoff", () => {
	const TOKEN_KEY = "helmor.companion.pat";
	type CompanionWindow = { __HELMOR_COMPANION__?: unknown };

	// A ReadableStream that stays open until `close()` is called — lets a test
	// model "stream opened, then dropped" precisely.
	function openStream(): {
		body: ReadableStream<Uint8Array>;
		close: () => void;
	} {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		return { body, close: () => controller.close() };
	}

	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState(null, "", "/");
		localStorage.setItem(TOKEN_KEY, "hlm_valid");
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = {
			base: "https://companion.test",
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = undefined;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState(null, "", "/");
	});

	it("backs off 1s→2s→4s…→30s (full jitter, capped, never gives up) and resets on re-open", async () => {
		// Pin jitter so each scheduled gap is exactly `r * window`, making the
		// doubling + 30s cap deterministically assertable. With full jitter the
		// real gap is random in [0, window]; r=0.5 lands mid-window.
		const r = 0.5;
		vi.spyOn(Math, "random").mockReturnValue(r);

		// Every connect attempt fails immediately → pure backoff loop, no body.
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new Error("sandbox asleep / cold start"));
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		// Starts healthy — no banner flash before the first real drop.
		expect(ipc.getCompanionConnectionState()).toBe("online");

		// Subscribing to a backend event opens the shared SSE stream.
		await ipc.listen("activeStreamsChanged", () => {});
		await vi.advanceTimersByTimeAsync(0);

		// First fetch already rejected → first drop → reconnecting.
		expect(ipc.getCompanionConnectionState()).toBe("reconnecting");

		// Windows double from base 1s and cap at 30s; gap = r * window.
		const windows = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
		let connectsSoFar = 1; // the initial failed connect
		for (const window of windows) {
			const expectedGap = r * window;
			// Not yet: just before the gap elapses, no new connect fired.
			await vi.advanceTimersByTimeAsync(expectedGap - 1);
			expect(fetchMock).toHaveBeenCalledTimes(connectsSoFar);
			// Cross the gap → exactly one more connect attempt.
			await vi.advanceTimersByTimeAsync(1);
			connectsSoFar += 1;
			expect(fetchMock).toHaveBeenCalledTimes(connectsSoFar);
			// Each gap stayed within the full-jitter envelope [0, window].
			expect(expectedGap).toBeGreaterThanOrEqual(0);
			expect(expectedGap).toBeLessThanOrEqual(window);
		}

		// Now a connect succeeds: stream opens, state clears, counter resets.
		const stream = openStream();
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: stream.body,
		});
		await vi.advanceTimersByTimeAsync(r * 30000);
		expect(ipc.getCompanionConnectionState()).toBe("online");

		// Drop again: because the counter reset, the FIRST gap is the 1s base
		// window again (not the 30s cap it had climbed to).
		fetchMock.mockRejectedValue(new Error("dropped again"));
		stream.close();
		await vi.advanceTimersByTimeAsync(0);
		expect(ipc.getCompanionConnectionState()).toBe("reconnecting");
		const callsBefore = fetchMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(r * 1000 - 1);
		expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(callsBefore + 1);
	});

	it("flips online → reconnecting → online and notifies subscribers", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const first = openStream();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, body: first.body });
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		const listener = vi.fn();
		const unsub = ipc.subscribeCompanionConnection(listener);

		// Open the stream — healthy connect must NOT flip state (no flash) and
		// must NOT notify (still "online").
		await ipc.listen("activeStreamsChanged", () => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(ipc.getCompanionConnectionState()).toBe("online");
		expect(listener).not.toHaveBeenCalled();

		// Drop → reconnecting, subscribers notified once.
		const second = openStream();
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: second.body,
		});
		first.close();
		await vi.advanceTimersByTimeAsync(0);
		expect(ipc.getCompanionConnectionState()).toBe("reconnecting");
		expect(listener).toHaveBeenCalledTimes(1);

		// Re-open after the backoff gap → back online, notified again.
		await vi.advanceTimersByTimeAsync(0.5 * 1000);
		expect(ipc.getCompanionConnectionState()).toBe("online");
		expect(listener).toHaveBeenCalledTimes(2);
		unsub();
	});

	it("routes subscribe_ui_mutations onto the shared /v1/stream and delivers ui-mutation events", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, body });
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		const received: unknown[] = [];
		const channel = new ipc.Channel<unknown>();
		channel.onmessage = (message) => received.push(message);

		// Subscribing must NOT open a dedicated /rpc-stream subscription (which the
		// proxy idle-closes and never reconnects) — it must ride the shared SSE.
		await ipc.invoke("subscribe_ui_mutations", {
			subscriptionId: "s1",
			onEvent: channel,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/stream");
		expect(String(fetchMock.mock.calls[0][0])).not.toContain("/rpc-stream");

		// A ui-mutation SSE frame from the backend reaches the channel, parsed.
		controller.enqueue(
			new TextEncoder().encode(
				'event: ui-mutation\ndata: {"type":"workspaceChanged","workspaceId":"w1"}\n\n',
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(received).toEqual([{ type: "workspaceChanged", workspaceId: "w1" }]);
	});

	it("native (non-remote) transport stays online and never opens the stream", async () => {
		// No companion marker → native (mocked-Tauri) transport.
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = undefined;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		expect(ipc.isRemoteTransport()).toBe(false);
		expect(ipc.getCompanionConnectionState()).toBe("online");

		// listen() routes to mocked Tauri, NOT the SSE loop — no fetch.
		await ipc.listen("activeStreamsChanged", () => {});
		await vi.advanceTimersByTimeAsync(60000);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(ipc.getCompanionConnectionState()).toBe("online");
	});
});
