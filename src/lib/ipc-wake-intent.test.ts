// R3-A Layer 2 (frontend half): wake-intent marking + typed-asleep handling
// on the companion transport. Mirrors the mock harness of ipc.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async () => undefined),
	Channel: class {},
	convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/platform", () => ({
	isMac: () => true,
	isTauriRuntime: () => true,
}));

function activateTeam() {
	localStorage.setItem("helmor.team.url", "https://team.example.com");
	localStorage.setItem("helmor.team.token", "hlm_secret");
	localStorage.setItem("helmor.team.mode", "1");
}

async function freshModules() {
	vi.resetModules();
	const ipc = await import("./ipc");
	const asleep = await import("./companion-asleep");
	return { ipc, asleep };
}

const ASLEEP_RESPONSE = () =>
	new Response(JSON.stringify({ code: "ContainerAsleep", asleep: true }), {
		status: 503,
		headers: { "content-type": "application/json" },
	});

function headersOf(fetchMock: { mock: { calls: unknown[][] } }, call = 0) {
	const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
	return (init?.headers ?? {}) as Record<string, string>;
}

describe("R3-A wake-intent marking", () => {
	beforeEach(() => {
		localStorage.clear();
		activateTeam();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("marks WAKE commands with X-Helmor-Wake-Intent", async () => {
		const fetchMock = vi.fn(
			async (..._args: unknown[]) => new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { ipc } = await freshModules();

		await ipc.invoke("post_room_chat_message", { text: "hi" });

		expect(fetchMock.mock.calls[0]?.[0]).toContain(
			"/rpc/post_room_chat_message",
		);
		expect(headersOf(fetchMock)["X-Helmor-Wake-Intent"]).toBe("1");
	});

	it("does NOT mark PASSIVE commands", async () => {
		const fetchMock = vi.fn(
			async (..._args: unknown[]) => new Response("[]", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { ipc } = await freshModules();

		await ipc.invoke("list_workspace_groups");

		expect(headersOf(fetchMock)["X-Helmor-Wake-Intent"]).toBeUndefined();
	});

	it("honors the explicit {wakeIntent: true} upgrade", async () => {
		const fetchMock = vi.fn(
			async (..._args: unknown[]) => new Response("[]", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { ipc } = await freshModules();

		await ipc.invoke("list_workspace_groups", undefined, { wakeIntent: true });

		expect(headersOf(fetchMock)["X-Helmor-Wake-Intent"]).toBe("1");
	});
});

describe("R3-A typed asleep", () => {
	beforeEach(() => {
		localStorage.clear();
		activateTeam();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("throws CompanionAsleepError for passive reads and flips the signal", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => ASLEEP_RESPONSE());
		vi.stubGlobal("fetch", fetchMock);
		const { ipc, asleep } = await freshModules();

		await expect(ipc.invoke("list_workspace_groups")).rejects.toSatisfy(
			(error: unknown) => asleep.isCompanionAsleepError(error),
		);
		expect(asleep.isCompanionAsleep()).toBe(true);
	});

	it("queues micro-writes while asleep and replays them on the next wake", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => ASLEEP_RESPONSE());
		vi.stubGlobal("fetch", fetchMock);
		const { ipc, asleep } = await freshModules();

		// Asleep: the micro-write resolves optimistically and queues.
		await expect(
			ipc.invoke("mark_session_read", { sessionId: "s1" }),
		).resolves.toBeUndefined();
		expect(asleep.isCompanionAsleep()).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Container wakes: the next successful response triggers the replay.
		fetchMock.mockImplementation(
			async () => new Response("[]", { status: 200 }),
		);
		await ipc.invoke("list_workspace_groups");
		await vi.waitFor(() => {
			const replayed = fetchMock.mock.calls.some((call) =>
				String(call[0]).includes("/rpc/mark_session_read"),
			);
			expect(replayed).toBe(true);
		});
		expect(asleep.isCompanionAsleep()).toBe(false);
	});

	it("drops presence while asleep (never queued, never replayed)", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => ASLEEP_RESPONSE());
		vi.stubGlobal("fetch", fetchMock);
		const { ipc } = await freshModules();

		await expect(
			ipc.invoke("report_presence", { state: "typing" }),
		).resolves.toBeUndefined();

		fetchMock.mockImplementation(
			async () => new Response("[]", { status: 200 }),
		);
		await ipc.invoke("list_workspace_groups");
		// Give any (incorrect) replay a chance to fire.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const replayed = fetchMock.mock.calls.filter((call) =>
			String(call[0]).includes("/rpc/report_presence"),
		);
		expect(replayed).toHaveLength(1); // only the original attempt
	});
});
