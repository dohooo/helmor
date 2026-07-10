import { describe, expect, it } from "vitest";
import { Sandbox } from "../src/index";

/**
 * F-4 (idle sleep never fired): `fetchCompanionPort` manually accounts
 * `inflightRequests` on the sandbox DO. The SDK's `isActivityExpired()`
 * treats ANY inflight as activity and re-arms the idle timer on every alarm
 * tick, so a single leaked decrement keeps the container awake (and billing)
 * forever. These tests pin the invariant: EVERY body-termination path —
 * clean close, downstream cancel (client disconnect), upstream error —
 * decrements exactly once.
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

function makeHarness(upstreamBody: ReadableStream<Uint8Array> | null) {
	const calls = { renew: 0, decrement: 0 };
	const self: Internals = {
		container: {
			running: true,
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
	// R3-A: these tests pin the F-4 decrementInflight release paths, which
	// only WAKE-marked requests take (a passive release decrements manually
	// without the base's renew-on-zero — see wake-intent.test.ts).
	const run = (request?: Request) =>
		fetchCompanionPort.call(
			self,
			request ??
				new Request("https://do.internal/v1/health", {
					headers: { "X-Helmor-Wake-Intent": "1" },
				}),
			8080,
		);
	return { self, calls, run };
}

async function settle() {
	// Let the background pipeTo → finally chain flush.
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("fetchCompanionPort inflight accounting (F-4)", () => {
	it("decrements when the upstream body closes cleanly", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("ok"));
				controller.close();
			},
		});
		const { self, calls, run } = makeHarness(body);

		const response = await run();
		expect(self.inflightRequests).toBe(1);
		// Drain the proxied body to completion.
		await response.text();
		await settle();

		expect(calls.decrement).toBe(1);
		expect(self.inflightRequests).toBe(0);
	});

	it("decrements when the CLIENT disconnects (downstream cancel)", async () => {
		// An SSE-like upstream that never closes on its own — the exact shape
		// that leaked before: with no outstanding read, the old pull()-based
		// wrapper never learned about the disconnect.
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("event: ping\n\n"));
				// intentionally never close
			},
		});
		const { self, calls, run } = makeHarness(body);

		const response = await run();
		expect(self.inflightRequests).toBe(1);
		// Simulate the client dropping the connection.
		await response.body?.cancel("client disconnected");
		await settle();

		expect(calls.decrement).toBe(1);
		expect(self.inflightRequests).toBe(0);
	});

	it("decrements when the upstream errors mid-stream", async () => {
		// Error from pull(), NOT synchronously in start(): pull() only fires
		// once a consumer is attached and asking for data, which is the real
		// "mid-stream" shape (a container doesn't die before the reader shows
		// up). A synchronous start() error rejects the stream before the
		// pipeThrough/pipeTo chain (and its .catch) is wired, and vitest
		// reports that as an unhandled rejection — failing the run (exit 1)
		// even with every assertion green.
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
			pull(controller) {
				controller.error(new Error("container dropped"));
			},
		});
		const { self, calls, run } = makeHarness(body);

		const response = await run();
		expect(self.inflightRequests).toBe(1);
		await response.text().catch(() => {});
		await settle();

		expect(calls.decrement).toBe(1);
		expect(self.inflightRequests).toBe(0);
	});

	it("decrements immediately for a body-less response", async () => {
		const { self, calls, run } = makeHarness(null);

		await run();
		await settle();

		expect(calls.decrement).toBe(1);
		expect(self.inflightRequests).toBe(0);
	});
});
