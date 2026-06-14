import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A distinguishable stand-in for Tauri's `Channel`, so a test can assert the
// `Channel` Proxy resolved the NATIVE class on the local transport. The real
// `@tauri-apps/api/core` mock in `src/test/setup.ts` ships a bare `Channel`
// class; we override it here per-file with a tagged subclass.
class FakeTauriChannel {
	readonly __isFakeTauri = true;
	onmessage: ((event: unknown) => void) | null = null;
}

const tauriInvoke = vi.fn(async () => undefined);
const tauriListen = vi.fn(async () => () => {});

vi.mock("@tauri-apps/api/core", () => ({
	Channel: FakeTauriChannel,
	convertFileSrc: (path: string) => `asset://localhost${path}`,
	invoke: tauriInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: tauriListen,
}));

// Pretend we're inside the Tauri desktop webview so the team↔local axis is the
// mutable one (a browser companion is fixed-remote and can't switch).
vi.mock("@/lib/platform", () => ({
	isMac: () => true,
	isTauriRuntime: () => true,
}));

function configureTeamBackend() {
	localStorage.setItem("helmor.team.url", "https://team.example.com");
	localStorage.setItem("helmor.team.token", "hlm_secret");
}

function activateTeamMode() {
	localStorage.setItem("helmor.team.mode", "1");
}

async function freshIpc() {
	vi.resetModules();
	return import("./ipc");
}

describe("ipc transport switch", () => {
	beforeEach(() => {
		localStorage.clear();
		tauriInvoke.mockClear();
		tauriListen.mockClear();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("boots local: native Channel, not remote, online", async () => {
		const ipc = await freshIpc();
		expect(ipc.isRemoteTransport()).toBe(false);
		expect(ipc.getCompanionConnectionState()).toBe("online");
		// The Proxy must produce a real (mocked) TauriChannel on the native path.
		const ch = new ipc.Channel();
		expect(ch).toBeInstanceOf(FakeTauriChannel);
		expect((ch as unknown as FakeTauriChannel).__isFakeTauri).toBe(true);
	});

	it("boots team mode remote when the flag + config are present at load", async () => {
		configureTeamBackend();
		activateTeamMode();
		const ipc = await freshIpc();
		expect(ipc.isRemoteTransport()).toBe(true);
		// Remote transport → the Proxy must NOT produce a TauriChannel.
		const ch = new ipc.Channel();
		expect(ch).not.toBeInstanceOf(FakeTauriChannel);
	});

	it("applyTransportSwitch flips local→team in place: remote, connecting, CompanionChannel", async () => {
		const ipc = await freshIpc();
		expect(ipc.isRemoteTransport()).toBe(false);

		// Simulate switchTeamMode's persistence step, then repoint.
		configureTeamBackend();
		activateTeamMode();
		ipc.applyTransportSwitch();

		expect(ipc.isRemoteTransport()).toBe(true);
		// Fresh entry into a remote transport surfaces the "connecting" loading
		// state up front (the new Worker is presumed cold).
		expect(ipc.getCompanionConnectionState()).toBe("connecting");
		// A Channel constructed AFTER the switch resolves to the companion class.
		const ch = new ipc.Channel();
		expect(ch).not.toBeInstanceOf(FakeTauriChannel);
	});

	it("applyTransportSwitch flips team→local in place: native, online, TauriChannel", async () => {
		configureTeamBackend();
		activateTeamMode();
		const ipc = await freshIpc();
		expect(ipc.isRemoteTransport()).toBe(true);

		// Switch back to local.
		localStorage.removeItem("helmor.team.mode");
		ipc.applyTransportSwitch();

		expect(ipc.isRemoteTransport()).toBe(false);
		// Native is synchronous — straight to online, no loading banner.
		expect(ipc.getCompanionConnectionState()).toBe("online");
		const ch = new ipc.Channel();
		expect(ch).toBeInstanceOf(FakeTauriChannel);
	});

	it("notifies connection subscribers across a switch", async () => {
		const ipc = await freshIpc();
		const states: string[] = [];
		ipc.subscribeCompanionConnection(() => {
			states.push(ipc.getCompanionConnectionState());
		});

		configureTeamBackend();
		activateTeamMode();
		ipc.applyTransportSwitch(); // online → connecting

		localStorage.removeItem("helmor.team.mode");
		ipc.applyTransportSwitch(); // connecting → online

		expect(states).toEqual(["connecting", "online"]);
	});
});

describe("ipc SSE loop teardown", () => {
	beforeEach(() => {
		localStorage.clear();
		tauriInvoke.mockClear();
		tauriListen.mockClear();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("aborts the in-flight /v1/stream fetch on teardown", async () => {
		configureTeamBackend();
		activateTeamMode();
		const ipc = await freshIpc();

		// A never-resolving stream body keeps the loop parked inside the fetch /
		// pumpSse so we can observe the abort. Capture the signal handed to fetch.
		let capturedSignal: AbortSignal | undefined;
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			capturedSignal = init?.signal ?? undefined;
			return new Promise<Response>(() => {}); // never resolves
		});
		vi.stubGlobal("fetch", fetchMock);

		// `listen` on a remote transport arms the shared SSE loop.
		await ipc.listen("ui-mutation", () => {});
		// Let the microtask that kicks off `runEventStream` run.
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(capturedSignal).toBeDefined();
		expect(capturedSignal?.aborted).toBe(false);

		// Switching away tears the loop down → the long-lived fetch is aborted.
		localStorage.removeItem("helmor.team.mode");
		ipc.applyTransportSwitch();

		expect(capturedSignal?.aborted).toBe(true);
	});

	it("a late-resolving fetch from a torn-down loop cannot flip connection state", async () => {
		configureTeamBackend();
		activateTeamMode();
		const ipc = await freshIpc();

		// First fetch resolves only AFTER we tear down — its `setOnline` must be
		// suppressed by the generation/abort guard.
		let resolveFirst: ((res: Response) => void) | undefined;
		const okBody = new ReadableStream<Uint8Array>({
			start() {
				/* open but idle — pumpSse parks reading */
			},
		});
		const fetchMock = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFirst = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await ipc.listen("ui-mutation", () => {});
		await Promise.resolve();
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// Seeded "connecting" from the switch-equivalent boot is not set here (we
		// booted directly into team mode, so state is the default "online" until a
		// drop). Force a known non-online baseline by tearing down first.
		localStorage.removeItem("helmor.team.mode");
		ipc.applyTransportSwitch(); // teardown bumps generation; state → online (local)
		expect(ipc.getCompanionConnectionState()).toBe("online");

		// NOW let the stale fetch resolve OK. The old loop must see it's no longer
		// current (aborted + generation bumped) and return WITHOUT setting online
		// or reopening — and crucially without throwing.
		resolveFirst?.(new Response(okBody, { status: 200 }));
		await Promise.resolve();
		await Promise.resolve();

		// Still online-local (the stale loop didn't touch state); no new fetch.
		expect(ipc.getCompanionConnectionState()).toBe("online");
		expect(ipc.isRemoteTransport()).toBe(false);
	});
});
