import { describe, expect, it } from "vitest";
import type { ForgeAccount } from "@/lib/api";
import { pickGithubIdentityAccount, toTeamIdentity } from "./use-team-identity";

function gh(partial: Partial<ForgeAccount>): ForgeAccount {
	return {
		provider: "github",
		host: "github.com",
		login: "octocat",
		active: false,
		id: "1",
		...partial,
	};
}

describe("pickGithubIdentityAccount", () => {
	it("prefers the active GitHub account", () => {
		const chosen = pickGithubIdentityAccount([
			gh({ login: "alt", id: "2", active: false }),
			gh({ login: "main", id: "1", active: true }),
		]);
		expect(chosen?.login).toBe("main");
	});

	it("falls back to the first GitHub account with a numeric id", () => {
		const chosen = pickGithubIdentityAccount([
			gh({ login: "first", id: "10", active: false }),
			gh({ login: "second", id: "20", active: false }),
		]);
		expect(chosen?.login).toBe("first");
	});

	it("ignores GitHub accounts missing a numeric id", () => {
		const chosen = pickGithubIdentityAccount([
			gh({ login: "noid", id: null, active: true }),
			gh({ login: "hasid", id: "5", active: false }),
		]);
		expect(chosen?.login).toBe("hasid");
	});

	it("ignores GitLab accounts (no numeric id space)", () => {
		const chosen = pickGithubIdentityAccount([
			{
				provider: "gitlab",
				host: "gitlab.com",
				login: "glabuser",
				active: true,
				id: null,
			},
		]);
		expect(chosen).toBeNull();
	});

	it("returns null when there are no qualifying accounts", () => {
		expect(pickGithubIdentityAccount([])).toBeNull();
	});
});

describe("toTeamIdentity", () => {
	it("maps a forge account into the accept payload", () => {
		expect(
			toTeamIdentity(
				gh({
					id: "583231",
					login: "octocat",
					name: "The Octocat",
					avatarUrl: "https://a/u",
				}),
			),
		).toEqual({
			githubId: "583231",
			login: "octocat",
			displayName: "The Octocat",
			avatarUrl: "https://a/u",
		});
	});

	it("returns null when the account has no numeric id", () => {
		expect(toTeamIdentity(gh({ id: null }))).toBeNull();
	});
});
