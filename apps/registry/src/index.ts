/// Helmor companion device registry (Cloudflare Worker).
///
/// The only Helmor-operated service in the companion architecture. It writes a
/// single `remote-<random>.helmor.ai` CNAME per paired desktop, pointing at
/// that desktop's Cloudflare Tunnel. It never sees the PAT or any user data —
/// only a tunnel UUID and (rate-limited) the caller IP.
///
/// Routes:
///   GET    /api/health
///   POST   /api/devices/register   { tunnelUuid }            -> { deviceId, hostname, secret }
///   DELETE /api/devices/:id        Authorization: Bearer <secret>

import { HttpError, registerDevice, revokeDevice } from "./devices";
import type { Env } from "./env";
import { checkRateLimit } from "./ratelimit";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/api/health") {
				return json({ status: "ok", service: "helmor-registry" });
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/devices/register"
			) {
				const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
				if (!(await checkRateLimit(env, ip))) {
					return json({ error: "rate_limited" }, 429);
				}
				const body = (await request.json().catch(() => ({}))) as {
					tunnelUuid?: string;
				};
				if (!body.tunnelUuid) throw new HttpError(400, "Missing tunnelUuid");
				return json(await registerDevice(env, body.tunnelUuid), 201);
			}

			const revoke = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
			if (request.method === "DELETE" && revoke) {
				const secret = bearer(request);
				if (!secret) return json({ error: "unauthorized" }, 401);
				await revokeDevice(env, revoke[1], secret);
				return new Response(null, { status: 204 });
			}

			return json({ error: "not_found" }, 404);
		} catch (err) {
			if (err instanceof HttpError) {
				return json({ error: err.message }, err.status);
			}
			console.error("registry error", err);
			return json({ error: "internal_error" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function bearer(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	return header.slice("Bearer ".length);
}
