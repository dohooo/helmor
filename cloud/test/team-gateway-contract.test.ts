import { describe, expect, it } from "vitest";
import {
	createLocalTeamGatewayStore,
	createLocalTeamProxy,
} from "../src/local-dev/proxy";
import { InMemoryLocalTeamRegistry } from "../src/local-dev/registry";
import {
	deriveGatewayForwardedRequest,
	handleTeamGatewayRoute,
	type TeamGatewayStore,
} from "../src/team-gateway/core";

const ADMIN_TOKEN = "hlm_gateway_admin_test";
const COMPANION_TOKEN = "hlm_gateway_companion_test";
const PUBLIC_URL = "http://127.0.0.1:8787";

describe("shared Team Gateway contract", () => {
	it("keeps /team bootstrap, invite, accept, and members semantics shared", async () => {
		const { store } = makeStore();

		const bootstrap = await teamRoute(store, "/team/bootstrap", {
			method: "POST",
			headers: auth(ADMIN_TOKEN),
		});
		expect(bootstrap.status).toBe(200);
		expect(await bootstrap.json()).toEqual({ ok: true, teamId: "team-0" });

		const invite = await teamRoute(store, "/team/invite", {
			method: "POST",
			headers: auth(ADMIN_TOKEN),
		});
		expect(invite.status).toBe(200);
		const inviteBody = (await invite.json()) as { token: string; url: string };
		expect(inviteBody.url).toBe(`${PUBLIC_URL}/?invite=${inviteBody.token}`);

		const accept = await teamRoute(store, "/team/accept", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: inviteBody.token,
				githubId: "member-1",
				login: "caspian",
				avatarUrl: "https://avatars.test/member-1.png",
			}),
		});
		expect(accept.status).toBe(200);
		expect(await accept.json()).toEqual({ ok: true, memberId: "member-1" });

		const members = await teamRoute(store, "/team/members", {
			headers: auth(inviteBody.token),
		});
		expect(members.status).toBe(200);
		expect(await members.json()).toEqual({
			members: [
				expect.objectContaining({
					id: "member-1",
					github_login: "caspian",
				}),
			],
		});
	});

	it("derives companion headers from bearer auth and strips forged member ids", async () => {
		const { store } = makeStore();
		const memberToken = await acceptMember(store);

		const bad = await deriveGatewayForwardedRequest(
			new Request(`${PUBLIC_URL}/rpc/get_data_info`, {
				headers: auth("wrong-token"),
			}),
			{ store, companionToken: COMPANION_TOKEN },
		);
		expect(bad).toBeInstanceOf(Response);
		expect((bad as Response).status).toBe(401);

		const admin = await deriveGatewayForwardedRequest(
			new Request(`${PUBLIC_URL}/rpc/get_data_info`, {
				headers: {
					...auth(ADMIN_TOKEN),
					"X-Helmor-Member-Id": "forged-admin",
				},
			}),
			{ store, companionToken: COMPANION_TOKEN },
		);
		expect(admin).not.toBeInstanceOf(Response);
		expect((admin as { headers: Headers }).headers.get("Authorization")).toBe(
			`Bearer ${COMPANION_TOKEN}`,
		);
		expect(
			(admin as { headers: Headers }).headers.get("X-Helmor-Member-Id"),
		).toBeNull();

		const member = await deriveGatewayForwardedRequest(
			new Request(`${PUBLIC_URL}/rpc-stream/post_room_chat_message`, {
				method: "POST",
				headers: {
					...auth(memberToken),
					"X-Helmor-Member-Id": "forged-member",
				},
				body: JSON.stringify({ content: "hello" }),
			}),
			{ store, companionToken: COMPANION_TOKEN },
		);
		expect(member).not.toBeInstanceOf(Response);
		expect((member as { headers: Headers }).headers.get("Authorization")).toBe(
			`Bearer ${COMPANION_TOKEN}`,
		);
		expect(
			(member as { headers: Headers }).headers.get("X-Helmor-Member-Id"),
		).toBe("member-1");
	});

	it("keeps local proxy forwarding shape for /rpc, /rpc-stream, and /v1", async () => {
		const registry = new InMemoryLocalTeamRegistry();
		const companionRequests: Request[] = [];
		const proxy = createLocalTeamProxy({
			registry,
			companionBaseUrl: "http://companion.local:8080",
			companionToken: COMPANION_TOKEN,
			adminToken: ADMIN_TOKEN,
			publicBaseUrl: PUBLIC_URL,
			fetchCompanion: async (request) => {
				companionRequests.push(request.clone());
				return json({ ok: true });
			},
		});
		const memberToken = await acceptProxyMember(proxy);

		await proxy.fetch(
			new Request(`${PUBLIC_URL}/rpc/get_data_info`, {
				method: "POST",
				headers: auth(memberToken),
				body: JSON.stringify({}),
			}),
		);
		await proxy.fetch(
			new Request(`${PUBLIC_URL}/rpc-stream/post_room_chat_message`, {
				method: "POST",
				headers: auth(memberToken),
				body: JSON.stringify({ content: "hello" }),
			}),
		);
		await proxy.fetch(
			new Request(`${PUBLIC_URL}/v1/health`, {
				headers: auth(memberToken),
			}),
		);

		expect(
			companionRequests.map((request) => new URL(request.url).pathname),
		).toEqual([
			"/rpc/get_data_info",
			"/rpc-stream/post_room_chat_message",
			"/v1/health",
		]);
		for (const request of companionRequests) {
			expect(request.headers.get("Authorization")).toBe(
				`Bearer ${COMPANION_TOKEN}`,
			);
			expect(request.headers.get("X-Helmor-Member-Id")).toBe("member-1");
		}
	});

	it("mirrors sessions + messages via /team/sync and serves them sandbox-independently", async () => {
		const { store } = makeStore();
		const memberToken = await acceptMember(store);

		// Container write-through (companion/admin token only).
		const sync = await teamRoute(store, "/team/sync", {
			method: "PUT",
			headers: { ...auth(ADMIN_TOKEN), "content-type": "application/json" },
			body: JSON.stringify({
				sessions: [
					{
						id: "s1",
						workspaceId: "w1",
						title: "Hello",
						status: "idle",
						sessionKind: "gui",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				],
				messages: [
					{
						id: "m1",
						sessionId: "s1",
						role: "user",
						content: '{"type":"user_prompt","text":"hi"}',
						sentAt: "2026-01-01T00:00:01Z",
					},
				],
			}),
		});
		expect(sync.status).toBe(200);

		// A member can READ the mirror (works with the sandbox asleep).
		const sessions = await teamRoute(store, "/team/sessions?workspaceId=w1", {
			headers: auth(memberToken),
		});
		expect(sessions.status).toBe(200);
		expect(await sessions.json()).toEqual({
			sessions: [
				expect.objectContaining({
					id: "s1",
					workspace_id: "w1",
					title: "Hello",
				}),
			],
		});

		const messages = await teamRoute(store, "/team/messages?sessionId=s1", {
			headers: auth(memberToken),
		});
		expect(messages.status).toBe(200);
		expect(await messages.json()).toEqual({
			messages: [
				expect.objectContaining({
					id: "m1",
					session_id: "s1",
					content: '{"type":"user_prompt","text":"hi"}',
				}),
			],
		});

		// A MEMBER token cannot write the mirror (companion-only).
		const forbidden = await teamRoute(store, "/team/sync", {
			method: "PUT",
			headers: { ...auth(memberToken), "content-type": "application/json" },
			body: JSON.stringify({ sessions: [] }),
		});
		expect(forbidden.status).toBe(401);

		// An unauthorized token cannot read.
		const unauth = await teamRoute(store, "/team/sessions?workspaceId=w1", {
			headers: auth("nope"),
		});
		expect(unauth.status).toBe(401);
	});

	it("prunes D1 sessions the container no longer has via replaceWorkspaceSessions", async () => {
		const { store } = makeStore();
		const memberToken = await acceptMember(store);
		const put = (body: unknown) =>
			teamRoute(store, "/team/sync", {
				method: "PUT",
				headers: { ...auth(ADMIN_TOKEN), "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const sessionIds = async () => {
			const res = await teamRoute(store, "/team/sessions?workspaceId=w1", {
				headers: auth(memberToken),
			});
			const { sessions } = (await res.json()) as {
				sessions: Array<{ id: string }>;
			};
			return sessions.map((s) => s.id).sort();
		};

		// Seed two sessions (each with a message).
		await put({
			sessions: [
				{ id: "s1", workspaceId: "w1" },
				{ id: "s2", workspaceId: "w1" },
			],
			messages: [
				{ id: "m1", sessionId: "s1", content: "a" },
				{ id: "m2", sessionId: "s2", content: "b" },
			],
		});
		expect(await sessionIds()).toEqual(["s1", "s2"]);

		// Authoritative set says only s1 remains → s2 (+ its messages) pruned.
		await put({
			replaceWorkspaceSessions: { workspaceId: "w1", sessionIds: ["s1"] },
		});
		expect(await sessionIds()).toEqual(["s1"]);
		const afterPrune = await teamRoute(store, "/team/messages?sessionId=s2", {
			headers: auth(memberToken),
		});
		expect(await afterPrune.json()).toEqual({ messages: [] });

		// Empty set → last session deleted → prune the whole workspace.
		await put({
			replaceWorkspaceSessions: { workspaceId: "w1", sessionIds: [] },
		});
		expect(await sessionIds()).toEqual([]);
	});
});

function makeStore(): {
	registry: InMemoryLocalTeamRegistry;
	store: TeamGatewayStore;
} {
	const registry = new InMemoryLocalTeamRegistry();
	const store = createLocalTeamGatewayStore({
		registry,
		adminToken: ADMIN_TOKEN,
		publicBaseUrl: PUBLIC_URL,
	});
	return { registry, store };
}

async function acceptMember(store: TeamGatewayStore): Promise<string> {
	await teamRoute(store, "/team/bootstrap", {
		method: "POST",
		headers: auth(ADMIN_TOKEN),
	});
	const invite = (await (
		await teamRoute(store, "/team/invite", {
			method: "POST",
			headers: auth(ADMIN_TOKEN),
		})
	).json()) as { token: string };
	await teamRoute(store, "/team/accept", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			token: invite.token,
			githubId: "member-1",
			login: "caspian",
		}),
	});
	return invite.token;
}

async function acceptProxyMember(
	proxy: ReturnType<typeof createLocalTeamProxy>,
): Promise<string> {
	await proxy.fetch(
		new Request(`${PUBLIC_URL}/team/bootstrap`, {
			method: "POST",
			headers: auth(ADMIN_TOKEN),
		}),
	);
	const invite = (await (
		await proxy.fetch(
			new Request(`${PUBLIC_URL}/team/invite`, {
				method: "POST",
				headers: auth(ADMIN_TOKEN),
			}),
		)
	).json()) as { token: string };
	await proxy.fetch(
		new Request(`${PUBLIC_URL}/team/accept`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: invite.token,
				githubId: "member-1",
				login: "caspian",
			}),
		}),
	);
	return invite.token;
}

async function teamRoute(
	store: TeamGatewayStore,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(`${PUBLIC_URL}${path}`, init);
	const response = await handleTeamGatewayRoute(
		request,
		new URL(request.url),
		store,
	);
	if (!response) throw new Error(`expected team response for ${path}`);
	return response;
}

function auth(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
