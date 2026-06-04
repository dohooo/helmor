/// Per-IP rate limiting for `register`, backed by a KV counter with a 24h TTL.

import type { Env } from "./env";

const WINDOW_SECONDS = 86_400;

/** Returns true if the call is allowed; increments the counter when it is. */
export async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
	const limit = Number(env.REGISTER_RATE_LIMIT ?? "10");
	const key = `ratelimit:${ip}`;
	const current = Number((await env.DEVICES.get(key)) ?? "0");
	if (current >= limit) return false;
	await env.DEVICES.put(key, String(current + 1), {
		expirationTtl: WINDOW_SECONDS,
	});
	return true;
}
