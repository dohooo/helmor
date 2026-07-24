import { describe, expect, it } from "vitest";
import { handleTeamEventPublish } from "../src/index";

/** Minimal fake Env: one member token in "D1", a TeamHub stub that records
 *  every broadcast body. */
function makeEnv(broadcasts: string[]) {
	return {
		HELMOR_COMPANION_TOKEN: "companion-secret",
		HELMOR_SANDBOX_ID: "sb-0",
		DB: {
			prepare: () => ({
				bind: (token: string) => ({
					first: async () =>
						token === "member-token" ? { member_id: "member-7" } : null,
				}),
			}),
		},
		TEAM_HUB: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (_url: string, init?: { body?: string }) => {
					broadcasts.push(String(init?.body ?? ""));
					return new Response(null, { status: 204 });
				},
			}),
		},
	} as never;
}

function publish(env: never, token: string, body: unknown) {
	return handleTeamEventPublish(
		new Request("https://w/team/event", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		env,
	);
}

const presenceFrame = (memberId: string) => ({
	event: "ui-mutation",
	data: {
		type: "roomPresenceChanged",
		memberId,
		workspaceId: "w1",
		sessionId: "s1",
		activity: "typing",
		ts: 1,
	},
});

describe("POST /team/event member publishing (R2-E, ruling correction C)", () => {
	it("member may publish the whitelisted presence kind — with memberId + ts STAMPED from the token, never the body", async () => {
		const broadcasts: string[] = [];
		const env = makeEnv(broadcasts);
		const res = await publish(env, "member-token", presenceFrame("FORGED-ID"));
		expect(res.status).toBe(204);
		const sent = JSON.parse(broadcasts[0]);
		expect(sent.data.memberId).toBe("member-7"); // forged id overwritten
		expect(sent.data.ts).not.toBe(1); // server-stamped
		expect(sent.data.activity).toBe("typing");
	});

	it("member may NOT publish any other ui-mutation kind (403)", async () => {
		const broadcasts: string[] = [];
		const env = makeEnv(broadcasts);
		const res = await publish(env, "member-token", {
			event: "ui-mutation",
			data: { type: "workspaceListChanged" },
		});
		expect(res.status).toBe(403);
		expect(broadcasts).toHaveLength(0);
	});

	it("unknown token is 401; companion token passes through unmodified", async () => {
		const broadcasts: string[] = [];
		const env = makeEnv(broadcasts);
		expect((await publish(env, "bad-token", presenceFrame("x"))).status).toBe(
			401,
		);

		const res = await publish(env, "companion-secret", {
			event: "ui-mutation",
			data: { type: "workspaceListChanged" },
		});
		expect(res.status).toBe(204);
		expect(JSON.parse(broadcasts[0]).data.type).toBe("workspaceListChanged");
	});

	it("member garbage body is 400", async () => {
		const env = makeEnv([]);
		expect((await publish(env, "member-token", "not json{{")).status).toBe(400);
	});
});
