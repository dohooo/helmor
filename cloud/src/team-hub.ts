// Helmor Team Cloud — TeamHub event plane (Stage C).
//
// A single hibernating Durable Object per team that relays realtime events
// (ui-mutations now; room chat / presence later) to every connected member over
// WebSockets — WITHOUT pinning the compute container. It uses the WebSocket
// Hibernation API, so an idle open connection accrues NO billable Duration
// (https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
// which is the whole point: desktops can stay connected for realtime while the
// sandbox sleeps.
//
// Flow:
//   - Desktops connect via the Worker's `GET /v1/ws`. The Worker validates the
//     bearer (carried in the WS subprotocol — browsers can't set headers) BEFORE
//     the upgrade reaches here and forwards the member id in `X-Helmor-Member-Id`;
//     the DO trusts that hop (it is reachable ONLY through the `TEAM_HUB`
//     binding, never publicly).
//   - The container / Worker `POST` events to `/broadcast` (same binding-only
//     reachability) → fan out to all live sockets.
//
// The DO holds NO secrets and reads NO D1 — it is a pure relay. Source of truth
// stays the container SQLite + the D1 mirror (Stage B).

import { DurableObject } from "cloudflare:workers";

/** Per-connection attachment, survives hibernation via `serializeAttachment`. */
interface ConnectionMeta {
	memberId: string;
}

/** Subprotocol the auto-ping/pong rides. The desktop sends `{"t":"ping"}`; the
 *  runtime replies `{"t":"pong"}` WITHOUT waking the DO (keepalive stays free). */
const PING = JSON.stringify({ t: "ping" });
const PONG = JSON.stringify({ t: "pong" });

export class TeamHub extends DurableObject<unknown> {
	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		// Set on every wake (cheap + idempotent). Keeps the socket alive while the
		// DO is hibernated — a manual ping would otherwise wake it on every beat.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(PING, PONG),
		);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Worker → hub: broadcast one already-shaped event line to every member.
		if (request.method === "POST" && url.pathname === "/broadcast") {
			this.broadcast(await request.text());
			return new Response(null, { status: 204 });
		}

		// Desktop → hub: accept a hibernatable WebSocket. The Worker already
		// validated the token and passes the member id via header.
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			const memberId = request.headers.get("X-Helmor-Member-Id") ?? "";
			const { 0: client, 1: server } = new WebSocketPair();
			// Hibernation: accept via the DO state (NOT `server.accept()`), so the
			// DO can be evicted from memory while the socket stays open.
			this.ctx.acceptWebSocket(server);
			server.serializeAttachment({ memberId } satisfies ConnectionMeta);
			// Echo the marker subprotocol so the browser handshake completes.
			return new Response(null, {
				status: 101,
				webSocket: client,
				headers: { "Sec-WebSocket-Protocol": "helmor.v1" },
			});
		}

		return new Response("Not found", { status: 404 });
	}

	/** Fan out one JSON event line (`{"event","data"}`) to all live sockets.
	 *  Best-effort: a dead socket is reaped by `webSocketClose`. */
	broadcast(line: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(line);
			} catch {
				// ignore — the close handler reaps it
			}
		}
	}

	// Broadcast-only hub for now: inbound member frames are ignored (presence can
	// ride this later). Defined so an accepted socket is a valid hibernation
	// target. Note: `{"t":"ping"}` never reaches here — the auto-responder
	// handles it while hibernated.
	async webSocketMessage(): Promise<void> {}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		try {
			// 1000-1015 are reserved; echo a safe code so we never throw.
			ws.close(code >= 1000 && code <= 1015 ? code : 1000, "closing");
		} catch {
			// already closed
		}
	}

	async webSocketError(): Promise<void> {
		// best-effort; close handling reaps the socket
	}
}
