import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acceptInvite,
	InviteAcceptFailure,
	listTeamMembers,
	listTeamWorkspaces,
} from "./team-api";

const IDENTITY = {
	githubId: "583231",
	login: "octocat",
	avatarUrl: "https://avatars.example/u/583231",
	displayName: "The Octocat",
};

describe("acceptInvite", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs to /team/accept with the token + identity and returns the result", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, memberId: "583231" }), {
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await acceptInvite(
			"https://team.example.com/",
			"tok-1",
			IDENTITY,
		);
		expect(result).toEqual({ ok: true, memberId: "583231" });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://team.example.com/team/accept");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual({
			token: "tok-1",
			githubId: "583231",
			login: "octocat",
			avatarUrl: "https://avatars.example/u/583231",
			displayName: "The Octocat",
		});
	});

	it.each([
		[404, "unknown"],
		[410, "expired"],
		[409, "claimed"],
		[500, "server"],
	])("maps HTTP %s to reason %s", async (status, reason) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("", { status })),
		);
		await expect(
			acceptInvite("https://team.example.com", "tok", IDENTITY),
		).rejects.toMatchObject({ reason });
	});

	it("maps a fetch rejection to a network failure", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const error = await acceptInvite(
			"https://team.example.com",
			"tok",
			IDENTITY,
		).catch((e) => e);
		expect(error).toBeInstanceOf(InviteAcceptFailure);
		expect(error.reason).toBe("network");
	});
});

describe("listTeamMembers / listTeamWorkspaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("GETs /team/members with the saved token as bearer", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					members: [
						{
							id: "1",
							github_login: "octocat",
							avatar_url: null,
							display_name: "Octo",
						},
					],
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const members = await listTeamMembers({
			url: "https://team.example.com",
			token: "hlm_tok",
		});
		expect(members).toHaveLength(1);
		expect(members[0].github_login).toBe("octocat");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://team.example.com/team/members",
			{ headers: { Authorization: "Bearer hlm_tok" } },
		);
	});

	it("throws on a non-2xx members response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("", { status: 401 })),
		);
		await expect(
			listTeamMembers({ url: "https://team.example.com", token: "bad" }),
		).rejects.toThrow(/HTTP 401/);
	});

	it("GETs /team/workspaces and unwraps the array", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						workspaces: [
							{ id: "w1", name: "api", status: "ready", created_at: 1 },
						],
					}),
					{ status: 200 },
				),
			),
		);
		const workspaces = await listTeamWorkspaces({
			url: "https://team.example.com",
			token: "hlm_tok",
		});
		expect(workspaces).toEqual([
			{ id: "w1", name: "api", status: "ready", created_at: 1 },
		]);
	});

	it("omits the Authorization header when no token is configured", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ members: [] }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		await listTeamMembers({ url: "https://team.example.com", token: "" });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://team.example.com/team/members",
			{ headers: {} },
		);
	});
});
