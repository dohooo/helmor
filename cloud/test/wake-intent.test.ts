import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	containerAsleepResponse,
	proxyWithoutWake,
	Sandbox,
	WAKE_INTENT_HEADER,
} from "../src/index";

/**
 * R3-A wake-intent double gate.
 *
 * Gate 1 (`route` → `proxyWithoutWake`): an UNMARKED request never calls
 * `ensureServe` — by construction the passive path only proxies; a sleeping /
 * not-yet-serving container yields the typed asleep shape.
 *
 * Gate 2 (`fetchCompanionPort`): an UNMARKED request never renews the idle
 * timer — not at request start, not through the streaming progress tap (a
 * watch stream's 30s keepalives feed the corpse watchdog only). This is what
 * finally makes "watching is free": renewals are the ONLY thing that keeps
 * the container awake (`isActivityExpired` ignores inflight — F-4).
 */

type Internals = {
	container: {
		running: boolean;
		getTcpPort: (port: number) => {
			fetch: (url: string, request: Request) => Promise<Response>;
		};
	};
	inflightRequests: number;
	renewActivityTimeout: () => void;
	decrementInflight: () => void;
};

function makeHarness(
	upstreamBody: ReadableStream<Uint8Array> | null,
	{ running = true } = {},
) {
	const calls = { renew: 0, decrement: 0 };
	const self: Internals = {
		container: {
			running,
			getTcpPort: () => ({
				fetch: async () => new Response(upstreamBody, { status: 200 }),
			}),
		},
		inflightRequests: 0,
		renewActivityTimeout: () => {
			calls.renew += 1;
		},
		decrementInflight: () => {
			calls.decrement += 1;
			self.inflightRequests -= 1;
		},
	};
	const fetchCompanionPort = (
		Sandbox.prototype as unknown as {
			fetchCompanionPort: (request: Request, port: number) => Promise<Response>;
		}
	).fetchCompanionPort;
	const run = (headers?: Record<string, string>) =>
		fetchCompanionPort.call(
			self,
			new Request("https://do.internal/rpc-stream/x", { headers }),
			8080,
		);
	return { self, calls, run };
}

/** An upstream that never closes, with a controller to drip keepalive bytes. */
function openEndedBody() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		body,
		push: (s: string) => controller.enqueue(new TextEncoder().encode(s)),
	};
}

describe("gate 2: fetchCompanionPort renew gating", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("answers the typed asleep shape when the container is not running", async () => {
		const { calls, run } = makeHarness(null, { running: false });
		const response = await run();
		expect(response.status).toBe(503);
		expect(response.headers.get("content-type")).toBe("application/json");
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.code).toBe("ContainerAsleep");
		expect(payload.asleep).toBe(true);
		expect(calls.renew).toBe(0);
	});

	it("unmarked request: forwards but never renews — even while stream bytes flow", async () => {
		const { body, push } = openEndedBody();
		const { self, calls, run } = makeHarness(body);

		const response = await run(); // no wake-intent header
		expect(self.inflightRequests).toBe(1); // F-4 accounting unchanged
		expect(calls.renew).toBe(0); // no request-start renew

		// Drip keepalives past the 60s renew throttle — a wake pipe would renew
		// here; a passive pipe must not.
		const reader = response.body?.getReader();
		push(":\n");
		await reader?.read();
		await vi.advanceTimersByTimeAsync(61_000);
		push(":\n");
		await reader?.read();
		expect(calls.renew).toBe(0);

		// Inflight accounting itself is unchanged and stays pinned by the F-4
		// suite (companion-port-inflight.test.ts); this test owns renew only.
		await reader?.cancel("client gone");
	});

	it("marked request: renews at start and through the progress tap", async () => {
		const { body, push } = openEndedBody();
		const { calls, run } = makeHarness(body);

		const response = await run({ [WAKE_INTENT_HEADER]: "1" });
		expect(calls.renew).toBe(1); // request-start renew

		const reader = response.body?.getReader();
		push("data\n");
		await reader?.read();
		expect(calls.renew).toBe(1); // inside the 60s throttle window
		await vi.advanceTimersByTimeAsync(61_000);
		push("data\n");
		await reader?.read();
		expect(calls.renew).toBe(2); // throttled progress renewal

		await reader?.cancel("done");
	});

	it("header lookup is case-insensitive (Headers semantics)", async () => {
		const { calls, run } = makeHarness(null);
		await run({ "x-helmor-wake-intent": "1" });
		expect(calls.renew).toBe(1);
	});
});

describe("gate 1: proxyWithoutWake (no ensureServe on the passive path)", () => {
	it("passes an awake container's answer through untouched", async () => {
		const sandbox = {
			fetch: async () => new Response('{"ok":true}', { status: 200 }),
		} as unknown as CloudflareSandbox;
		const response = await proxyWithoutWake(
			sandbox,
			new Request("https://worker.example/rpc/list_workspace_groups"),
			8080,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"ok":true}');
	});

	it("passes the DO's typed asleep through to the client", async () => {
		const sandbox = {
			fetch: async () => containerAsleepResponse(),
		} as unknown as CloudflareSandbox;
		const response = await proxyWithoutWake(
			sandbox,
			new Request("https://worker.example/rpc/list_workspace_groups"),
			8080,
		);
		expect(response.status).toBe(503);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.code).toBe("ContainerAsleep");
	});

	it("maps a mid-cold-start connection failure to the typed asleep shape", async () => {
		const sandbox = {
			fetch: async () => {
				throw new Error("connection refused: serve not listening");
			},
		} as unknown as CloudflareSandbox;
		const response = await proxyWithoutWake(
			sandbox,
			new Request("https://worker.example/rpc/get_workspace"),
			8080,
		);
		expect(response.status).toBe(503);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.code).toBe("ContainerAsleep");
		expect(payload.asleep).toBe(true);
	});
});

describe("typed asleep response shape", () => {
	it("matches the contract the frontend parses", async () => {
		const payload = await containerAsleepResponse().json();
		expect(payload).toEqual({
			code: "ContainerAsleep",
			asleep: true,
			message:
				"The sandbox is asleep; passive requests return stale data until an explicit action wakes it.",
		});
	});
});
