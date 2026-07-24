import { describe, expect, it } from "vitest";
import { createLocalTeamProxy } from "../src/local-dev/proxy";
import { InMemoryLocalTeamRegistry } from "../src/local-dev/registry";

const ADMIN_TOKEN = "hlm_local_admin_test";
const COMPANION_TOKEN = "hlm_local_companion_test";
const PUBLIC_URL = "http://127.0.0.1:8787";

function makeProxy() {
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
			if (new URL(request.url).pathname === "/rpc/clone_repository_from_url") {
				return json({
					repositoryId: "repo-1",
					selectedWorkspaceId: "ws-1",
				});
			}
			return json({ ok: true });
		},
	});
	return { proxy, registry, companionRequests };
}

async function acceptMember(
	proxy: ReturnType<typeof makeProxy>["proxy"],
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
	).json()) as { token: string; url: string };
	expect(invite.url).toBe(`${PUBLIC_URL}/?invite=${invite.token}`);

	const accept = await proxy.fetch(
		new Request(`${PUBLIC_URL}/team/accept`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: invite.token,
				githubId: "member-1",
				login: "caspian",
				avatarUrl: "https://avatars.test/member-1.png",
			}),
		}),
	);
	expect(accept.status).toBe(200);
	return invite.token;
}

describe("local Docker Team proxy", () => {
	it("implements bootstrap, invite, accept, members, and auth failures", async () => {
		const { proxy } = makeProxy();
		const token = await acceptMember(proxy);

		const members = (await (
			await proxy.fetch(
				new Request(`${PUBLIC_URL}/team/members`, {
					headers: auth(token),
				}),
			)
		).json()) as { members: Array<{ id: string; github_login: string }> };
		expect(members.members).toEqual([
			expect.objectContaining({ id: "member-1", github_login: "caspian" }),
		]);

		const denied = await proxy.fetch(
			new Request(`${PUBLIC_URL}/team/members`, {
				headers: auth("wrong-token"),
			}),
		);
		expect(denied.status).toBe(401);
	});

	it("strips forged member headers and injects the derived member id", async () => {
		const { proxy, companionRequests } = makeProxy();
		const token = await acceptMember(proxy);

		await proxy.fetch(
			new Request(`${PUBLIC_URL}/rpc-stream/post_room_chat_message`, {
				method: "POST",
				headers: {
					...auth(token),
					"content-type": "application/json",
					"X-Helmor-Member-Id": "evil-header",
				},
				body: JSON.stringify({ authorId: "evil-body", content: "hello" }),
			}),
		);

		const forwarded = companionRequests.at(-1);
		expect(forwarded?.headers.get("Authorization")).toBe(
			`Bearer ${COMPANION_TOKEN}`,
		);
		expect(forwarded?.headers.get("X-Helmor-Member-Id")).toBe("member-1");
	});

	it("maps the admin token to the companion token without a member id", async () => {
		const { proxy, companionRequests } = makeProxy();

		await proxy.fetch(
			new Request(`${PUBLIC_URL}/rpc/get_data_info`, {
				method: "POST",
				headers: auth(ADMIN_TOKEN),
				body: JSON.stringify({}),
			}),
		);

		const forwarded = companionRequests.at(-1);
		expect(forwarded?.headers.get("Authorization")).toBe(
			`Bearer ${COMPANION_TOKEN}`,
		);
		expect(forwarded?.headers.get("X-Helmor-Member-Id")).toBeNull();
	});

	it("does not give unknown bearers access to health or rpc", async () => {
		const { proxy, companionRequests } = makeProxy();

		const health = await proxy.fetch(
			new Request(`${PUBLIC_URL}/v1/health`, {
				headers: auth("wrong-token"),
			}),
		);
		const rpc = await proxy.fetch(
			new Request(`${PUBLIC_URL}/rpc/get_data_info`, {
				method: "POST",
				headers: auth("wrong-token"),
				body: JSON.stringify({}),
			}),
		);

		expect(health.status).toBe(401);
		expect(rpc.status).toBe(401);
		expect(companionRequests).toHaveLength(0);
	});

	it("keeps local cloud identity routes metadata-only", async () => {
		const { proxy } = makeProxy();
		const token = await acceptMember(proxy);

		const adminPut = await proxy.fetch(
			new Request(`${PUBLIC_URL}/team/cloud-identity`, {
				method: "PUT",
				headers: { ...auth(ADMIN_TOKEN), "content-type": "application/json" },
				body: JSON.stringify({ refreshToken: "rt", idToken: "id.token" }),
			}),
		);
		expect(adminPut.status).toBe(401);

		const idToken = makeIdToken({ sub: "acct-1" });
		const put = await proxy.fetch(
			new Request(`${PUBLIC_URL}/team/cloud-identity`, {
				method: "PUT",
				headers: { ...auth(token), "content-type": "application/json" },
				body: JSON.stringify({ refreshToken: "rt-secret", idToken }),
			}),
		);
		expect(put.status).toBe(200);

		const status = (await (
			await proxy.fetch(
				new Request(`${PUBLIC_URL}/team/cloud-identity`, {
					headers: auth(ADMIN_TOKEN),
				}),
			)
		).json()) as Record<string, unknown>;
		expect(status).toEqual({
			hasToken: true,
			accountId: "acct-1",
			accessExp: null,
			bricked: false,
		});
		expect(JSON.stringify(status)).not.toContain("rt-secret");
	});

	it("mirrors a successful clone into /team/workspaces", async () => {
		const { proxy } = makeProxy();
		const token = await acceptMember(proxy);

		await proxy.fetch(
			new Request(`${PUBLIC_URL}/rpc/clone_repository_from_url`, {
				method: "POST",
				headers: { ...auth(token), "content-type": "application/json" },
				body: JSON.stringify({ gitUrl: "https://github.com/acme/foo.git" }),
			}),
		);

		const workspaces = (await (
			await proxy.fetch(
				new Request(`${PUBLIC_URL}/team/workspaces`, {
					headers: auth(token),
				}),
			)
		).json()) as { workspaces: Array<{ id: string; name: string }> };
		expect(workspaces.workspaces).toEqual([
			expect.objectContaining({ id: "ws-1", name: "foo" }),
		]);
	});

	it("seeds a fixed invite token so the dev member token is stable", async () => {
		// `dev:team` seeds a known token (instead of a random UUID) so the desktop
		// can default to it with no manual entry. The seeded token must classify
		// as a member after acceptance — and a random one stays random.
		const registry = new InMemoryLocalTeamRegistry();
		const fixed = await registry.createInvite({
			baseUrl: PUBLIC_URL,
			token: "hlm_dev_team_local",
		});
		expect(fixed.token).toBe("hlm_dev_team_local");
		await registry.acceptInvite({
			token: fixed.token,
			githubId: "dev",
			login: "dev",
		});
		expect(await registry.classify(fixed.token, ADMIN_TOKEN)).toMatchObject({
			caller: "member",
		});
		const random = await registry.createInvite({ baseUrl: PUBLIC_URL });
		expect(random.token).not.toBe("hlm_dev_team_local");
	});

	it("stores the Claude token for container injection but never exposes it over HTTP", async () => {
		const registry = new InMemoryLocalTeamRegistry();
		await registry.putClaudeIdentity("member-1", {
			oauthToken: "sk-ant-oat01-secret",
		});
		// The launcher reads the raw token to inject as CLAUDE_CODE_OAUTH_TOKEN…
		expect(registry.getClaudeToken()).toBe("sk-ant-oat01-secret");
		// …but the HTTP-facing status exposes only the boolean flag.
		expect(await registry.getClaudeIdentity()).toEqual({ hasToken: true });
	});

	it("recreates the container after a successful Claude (re)authorize", async () => {
		const registry = new InMemoryLocalTeamRegistry();
		let restarts = 0;
		const proxy = createLocalTeamProxy({
			registry,
			companionBaseUrl: "http://companion.local:8080",
			companionToken: COMPANION_TOKEN,
			adminToken: ADMIN_TOKEN,
			publicBaseUrl: PUBLIC_URL,
			fetchCompanion: async () => json({ ok: true }),
			restartCompanion: async () => {
				restarts += 1;
			},
		});
		const token = await acceptMember(proxy);
		const res = await proxy.fetch(
			new Request(`${PUBLIC_URL}/team/claude-identity`, {
				method: "PUT",
				headers: { ...auth(token), "content-type": "application/json" },
				body: JSON.stringify({ oauthToken: "sk-ant-oat01-x" }),
			}),
		);
		expect(res.status).toBe(200);
		expect(restarts).toBe(1);
		expect(registry.getClaudeToken()).toBe("sk-ant-oat01-x");
	});
});

function auth(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function makeIdToken(payload: Record<string, unknown>): string {
	return `x.${btoa(JSON.stringify(payload))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "")}.x`;
}
