import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the companion live-update multiplexer (src/lib/ipc.ts): the single
// reconnecting `/v1/ws` WebSocket that carries `ui-mutation` / `session` frames,
// replacing the old non-reconnecting `/rpc-stream/subscribe_*` fetches that left
// the mobile UI frozen after a background/lock. WebSocket (not SSE) because
// cloudflare quick tunnels buffer `text/event-stream` indefinitely.
//
// `window.__HELMOR_COMPANION__` flips the module onto the HTTP/WebSocket path;
// `vi.resetModules()` re-evaluates the module-level `COMPANION` const per test.

type CompanionWindow = { __HELMOR_COMPANION__?: unknown };

/** A mock `WebSocket` the test drives: each instance records its URL and the
 *  test pushes server frames via `emit(event, data)`. */
class MockWebSocket {
	static instances: MockWebSocket[] = [];
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	closed = false;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
		// Open on a microtask, mirroring a real socket's async handshake.
		queueMicrotask(() => this.onopen?.());
	}

	send(): void {}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.();
	}

	/** Deliver a server `{ event, data }` text frame to the client. */
	emit(event: string, data: unknown): void {
		this.onmessage?.({ data: JSON.stringify({ event, data }) });
	}
}

describe("companion live-update multiplexer", () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState(null, "", "/");
		localStorage.setItem("helmor.companion.pat", "hlm_valid");
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = {
			base: "https://companion.test",
		};
		MockWebSocket.instances = [];
		vi.stubGlobal("WebSocket", MockWebSocket);
	});

	afterEach(() => {
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = undefined;
		vi.unstubAllGlobals();
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState(null, "", "/");
	});

	it("routes subscribe_ui_mutations to a /v1/ws socket (never /rpc-stream) and delivers frames", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		const channel = new ipc.Channel();
		const onmessage = vi.fn();
		channel.onmessage = onmessage;
		await ipc.invoke("subscribe_ui_mutations", {
			subscriptionId: "sub-1",
			onEvent: channel,
		});

		await vi.waitFor(() =>
			expect(MockWebSocket.instances.length).toBeGreaterThan(0),
		);
		const socket = MockWebSocket.instances[0];
		// `wss://` upgrade to `/v1/ws`, and never a `/rpc-stream` fetch.
		expect(socket.url).toBe("wss://companion.test/v1/ws");
		const urls = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(urls.some((u) => u.includes("/rpc-stream"))).toBe(false);

		socket.emit("ui-mutation", { type: "workspaceListChanged" });
		await vi.waitFor(() =>
			expect(onmessage).toHaveBeenCalledWith({ type: "workspaceListChanged" }),
		);
	});

	it("routes subscribe_session_stream through /v1/ws?watch= and delivers session frames", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue({ ok: true, status: 200, text: async () => "" }),
		);

		const ipc = await import("./ipc");
		const channel = new ipc.Channel();
		const onmessage = vi.fn();
		channel.onmessage = onmessage;
		await ipc.invoke("subscribe_session_stream", {
			sessionId: "s1",
			subscriptionId: "sub-1",
			onEvent: channel,
		});

		await vi.waitFor(() =>
			expect(
				MockWebSocket.instances.some((w) => w.url.includes("/v1/ws?watch=s1")),
			).toBe(true),
		);
		const socket = MockWebSocket.instances.find((w) =>
			w.url.includes("watch=s1"),
		);
		socket?.emit("session", { kind: "update", messages: [] });
		await vi.waitFor(() =>
			expect(onmessage).toHaveBeenCalledWith({ kind: "update", messages: [] }),
		);
	});

	it("fires onCompanionStreamReconnect on every hello frame", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue({ ok: true, status: 200, text: async () => "" }),
		);

		const ipc = await import("./ipc");
		const onReconnect = vi.fn();
		ipc.onCompanionStreamReconnect(onReconnect);

		// Attaching a subscriber opens the socket.
		const channel = new ipc.Channel();
		channel.onmessage = vi.fn();
		await ipc.invoke("subscribe_ui_mutations", {
			subscriptionId: "sub-1",
			onEvent: channel,
		});

		await vi.waitFor(() =>
			expect(MockWebSocket.instances.length).toBeGreaterThan(0),
		);
		const socket = MockWebSocket.instances[0];
		socket.emit("hello", {});
		await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
		socket.emit("hello", {});
		await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(2));
	});

	it("treats companion unsubscribe_* as a no-op (no request)", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		await expect(
			ipc.invoke("unsubscribe_ui_mutations", { subscriptionId: "sub-1" }),
		).resolves.toBeUndefined();
		await expect(
			ipc.invoke("unsubscribe_session_stream", {
				sessionId: "s1",
				subscriptionId: "sub-1",
			}),
		).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(MockWebSocket.instances.length).toBe(0);
	});

	it("proactively reopens the socket on a reconnect trigger (online / foreground)", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue({ ok: true, status: 200, text: async () => "" }),
		);

		const ipc = await import("./ipc");
		const channel = new ipc.Channel();
		channel.onmessage = vi.fn();
		await ipc.invoke("subscribe_ui_mutations", {
			subscriptionId: "sub-1",
			onEvent: channel,
		});
		await vi.waitFor(() =>
			expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1),
		);
		const before = MockWebSocket.instances.length;

		// A network-restore / foreground event must close the current socket and
		// reopen at once — the silent-hang the watchdog/visibility triggers exist
		// for. A fresh socket beyond `before` proves the reconnect fired. (Exact
		// count is avoided: the persistent `runEventStream` loop + DOM listeners
		// survive `vi.resetModules()`, so prior tests' modules may also reopen.)
		window.dispatchEvent(new Event("online"));
		await vi.waitFor(() =>
			expect(MockWebSocket.instances.length).toBeGreaterThan(before),
		);
	});
});

describe("companion stream helpers off companion", () => {
	beforeEach(() => {
		vi.resetModules();
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = undefined;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("onCompanionStreamReconnect is inert on the desktop runtime", async () => {
		const ipc = await import("./ipc");
		const cb = vi.fn();
		const unsubscribe = ipc.onCompanionStreamReconnect(cb);
		expect(typeof unsubscribe).toBe("function");
		unsubscribe(); // must not throw
		expect(cb).not.toHaveBeenCalled();
	});
});
