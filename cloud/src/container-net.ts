// Low-level container plumbing shared by the Worker entry (index.ts) and the
// team registry routes (team.ts): fetch-through-port, bounded awaits, and the
// non-waking health probe.
//
// Extracted from index.ts (round6 P1-4a) so team.ts can probe container
// liveness without a runtime import of index.ts — team.ts ⇄ index.ts would be
// a value-import cycle (index.ts already imports the team routes).

import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

export const HEALTH_CHECK_TIMEOUT_MS = 1_500;

/** Proxy one request to the in-container companion server on `port`. Prefers
 *  the Durable Object `fetch` (port-switched URL) when the stub exposes it;
 *  falls back to the SDK's `containerFetch`. NON-WAKING in the R3-A sense:
 *  a container that isn't serving makes this REJECT (see `proxyWithoutWake` in
 *  index.ts) — it never runs `ensureServe`. */
export function containerFetchThroughPort(
	sandbox: CloudflareSandbox,
	request: Request,
	port: number,
): Promise<Response> {
	const url = new URL(request.url);
	const target = `http://localhost:${port}${url.pathname}${url.search}`;
	const proxyUrl = new URL(request.url);
	proxyUrl.pathname = `/__helmor-companion/${port}${url.pathname}`;
	const init: RequestInit = {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
	};
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body;
	}
	const fetchThroughDurableObject = (sandbox as { fetch?: typeof fetch }).fetch;
	if (fetchThroughDurableObject) {
		return fetchThroughDurableObject(new Request(proxyUrl.toString(), init));
	}
	return sandbox.containerFetch(target, init, port);
}

/** Probe the companion's `/v1/health` WITHOUT waking a sleeping container
 *  (same non-waking `containerFetchThroughPort` semantics as
 *  `proxyWithoutWake`): a container that isn't serving times out / rejects →
 *  `false`. Kept short so callers can use it as a cheap "is it serving?"
 *  guard. */
export async function healthOk(
	sandbox: CloudflareSandbox,
	port: number,
	timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await withTimeout(
			containerFetchThroughPort(
				sandbox,
				new Request(`http://localhost:${port}/v1/health`, {
					signal: controller.signal,
				}),
				port,
			),
			timeoutMs,
			"health check",
		);
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

/** Race `promise` against a deadline; a breach rejects with a labeled
 *  `… timed out after Nms` error. */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
