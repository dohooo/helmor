import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the companion live-update multiplexer (src/lib/ipc.ts): the single
// reconnecting `/v1/stream` SSE that carries `ui-mutation` / `session` frames,
// replacing the old non-reconnecting `/rpc-stream/subscribe_*` fetches that left
// the mobile UI frozen after a background/lock.
//
// `window.__HELMOR_COMPANION__` flips the module onto the HTTP/SSE path;
// `vi.resetModules()` re-evaluates the module-level `COMPANION` const per test.

type CompanionWindow = { __HELMOR_COMPANION__?: unknown };

/** A mock `fetch` SSE response whose frames the test pushes on demand. */
function makeSseResponse() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	let closed = false;
	return {
		response: { ok: true, status: 200, body },
		push(event: string, data: unknown) {
			if (closed) return;
			controller.enqueue(
				encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
			);
		},
		close() {
			if (closed) return;
			closed = true;
			controller.close();
		},
	};
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
	});

	afterEach(() => {
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = undefined;
		vi.unstubAllGlobals();
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState(null, "", "/");
	});

	it("routes subscribe_ui_mutations to /v1/stream (never /rpc-stream) and delivers frames", async () => {
		const sse = makeSseResponse();
		const fetchMock = vi.fn((url: string) => {
			if (String(url).includes("/v1/stream")) {
				return Promise.resolve(sse.response);
			}
			return Promise.resolve({ ok: true, status: 200, text: async () => "" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		const channel = new ipc.Channel();
		const onmessage = vi.fn();
		channel.onmessage = onmessage;
		await ipc.invoke("subscribe_ui_mutations", {
			subscriptionId: "sub-1",
			onEvent: channel,
		});

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const urls = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(urls.some((u) => u.includes("/v1/stream"))).toBe(true);
		expect(urls.some((u) => u.includes("/rpc-stream"))).toBe(false);

		sse.push("ui-mutation", { type: "workspaceListChanged" });
		await vi.waitFor(() =>
			expect(onmessage).toHaveBeenCalledWith({ type: "workspaceListChanged" }),
		);
		sse.close();
	});

	it("routes subscribe_session_stream through /v1/stream?watch= and delivers session frames", async () => {
		const sse = makeSseResponse();
		const fetchMock = vi.fn((url: string, opts?: { signal?: AbortSignal }) => {
			if (String(url).includes("/v1/stream")) {
				opts?.signal?.addEventListener("abort", () => sse.close());
				return Promise.resolve(sse.response);
			}
			return Promise.resolve({ ok: true, status: 200, text: async () => "" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		const channel = new ipc.Channel();
		const onmessage = vi.fn();
		channel.onmessage = onmessage;
		await ipc.invoke("subscribe_session_stream", {
			sessionId: "s1",
			subscriptionId: "sub-1",
			onEvent: channel,
		});

		await vi.waitFor(() => {
			const urls = fetchMock.mock.calls.map((call) => String(call[0]));
			expect(urls.some((u) => u.includes("/v1/stream?watch=s1"))).toBe(true);
		});

		sse.push("session", { kind: "update", messages: [] });
		await vi.waitFor(() =>
			expect(onmessage).toHaveBeenCalledWith({ kind: "update", messages: [] }),
		);
		sse.close();
	});

	it("fires onCompanionStreamReconnect on every hello frame", async () => {
		const sse = makeSseResponse();
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) =>
				String(url).includes("/v1/stream")
					? Promise.resolve(sse.response)
					: Promise.resolve({ ok: true, status: 200, text: async () => "" }),
			),
		);

		const ipc = await import("./ipc");
		const onReconnect = vi.fn();
		ipc.onCompanionStreamReconnect(onReconnect);

		// Attaching a subscriber opens the stream.
		const channel = new ipc.Channel();
		channel.onmessage = vi.fn();
		await ipc.invoke("subscribe_ui_mutations", {
			subscriptionId: "sub-1",
			onEvent: channel,
		});

		sse.push("hello", {});
		await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
		sse.push("hello", {});
		await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(2));
		sse.close();
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
	});

	it("reconnects the SSE when the tab returns to the foreground", async () => {
		const sse = makeSseResponse();
		let streamCalls = 0;
		const fetchMock = vi.fn((url: string, opts?: { signal?: AbortSignal }) => {
			if (String(url).includes("/v1/stream")) {
				streamCalls += 1;
				if (streamCalls === 1) {
					// A real fetch's body errors on abort; mirror that so pumpSse
					// returns and the loop reconnects.
					opts?.signal?.addEventListener("abort", () => sse.close());
					return Promise.resolve(sse.response);
				}
				// Park the reconnect so the loop doesn't spin after the assertion.
				return new Promise(() => {});
			}
			return Promise.resolve({ ok: true, status: 200, text: async () => "" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		const channel = new ipc.Channel();
		channel.onmessage = vi.fn();
		await ipc.invoke("subscribe_ui_mutations", {
			subscriptionId: "sub-1",
			onEvent: channel,
		});
		await vi.waitFor(() => expect(streamCalls).toBe(1));

		// Returning to a backgrounded/locked tab must proactively rebuild the
		// stream (the silent-hang the watchdog/visibility triggers exist for).
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => expect(streamCalls).toBe(2));
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
