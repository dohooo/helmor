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

	it("keeps local-only identity commands on Tauri in desktop team mode", async () => {
		configureTeamBackend();
		activateTeamMode();
		const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const ipc = await freshIpc();

		await ipc.invoke("list_forge_accounts", { gitlabHosts: [] });

		expect(tauriInvoke).toHaveBeenCalledWith("list_forge_accounts", {
			gitlabHosts: [],
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps pasted-image writes on local disk in desktop team mode", async () => {
		configureTeamBackend();
		activateTeamMode();
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const ipc = await freshIpc();

		await ipc.invoke("save_pasted_image", {
			data: "x",
			mediaType: "image/png",
			sessionId: "s",
		});

		expect(tauriInvoke).toHaveBeenCalledWith("save_pasted_image", {
			data: "x",
			mediaType: "image/png",
			sessionId: "s",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses the local asset protocol for known-local files in desktop team mode", async () => {
		configureTeamBackend();
		activateTeamMode();
		const ipc = await freshIpc();

		expect(ipc.convertFileSrc("/remote/avatar.png")).toBe(
			"https://team.example.com/v1/asset?path=%2Fremote%2Favatar.png",
		);
		expect(ipc.convertLocalFileSrc("/local/avatar.png")).toBe(
			"asset://localhost/local/avatar.png",
		);
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

/** Minimal WebSocket stand-in for the team event stream: records construction,
 *  sends, and close, and lets a test drive the lifecycle handlers. */
class MockWebSocket {
	static instances: MockWebSocket[] = [];
	url: string;
	protocols?: string | string[];
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	sent: string[] = [];
	constructor(url: string, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
		MockWebSocket.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
	}
}

describe("ipc event-stream loop teardown", () => {
	beforeEach(() => {
		localStorage.clear();
		tauriInvoke.mockClear();
		tauriListen.mockClear();
		vi.unstubAllGlobals();
		MockWebSocket.instances.length = 0;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("closes the in-flight /v1/ws WebSocket on teardown", async () => {
		configureTeamBackend();
		activateTeamMode();
		const ipc = await freshIpc();

		vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);

		// `listen` on a remote transport arms the shared loop, which opens the
		// WebSocket synchronously inside pumpWebSocket.
		await ipc.listen("ui-mutation", () => {});
		await Promise.resolve();
		await Promise.resolve();

		expect(MockWebSocket.instances).toHaveLength(1);
		const ws = MockWebSocket.instances[0];
		expect(ws.url).toContain("/v1/ws");
		// Auth rides the WS subprotocol (browsers can't set Authorization).
		expect(ws.protocols).toEqual(["helmor.v1", expect.any(String)]);
		expect(ws.closed).toBe(false);

		// Switching away tears the loop down → the socket is closed.
		localStorage.removeItem("helmor.team.mode");
		ipc.applyTransportSwitch();

		expect(ws.closed).toBe(true);
	});

	it("a late onopen from a torn-down loop cannot flip connection state", async () => {
		configureTeamBackend();
		activateTeamMode();
		const ipc = await freshIpc();

		vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);

		await ipc.listen("ui-mutation", () => {});
		await Promise.resolve();
		await Promise.resolve();
		expect(MockWebSocket.instances).toHaveLength(1);
		const ws = MockWebSocket.instances[0];

		// Tear down before the socket reports open.
		localStorage.removeItem("helmor.team.mode");
		ipc.applyTransportSwitch(); // teardown bumps generation; state → online (local)
		expect(ipc.getCompanionConnectionState()).toBe("online");
		expect(ws.closed).toBe(true); // teardown closed the stale socket

		// A late open from the torn-down loop must NOT flip to online or reopen.
		ws.onopen?.();
		await Promise.resolve();

		expect(ipc.getCompanionConnectionState()).toBe("online");
		expect(ipc.isRemoteTransport()).toBe(false);
	});
});
