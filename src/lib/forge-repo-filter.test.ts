import { describe, expect, it } from "vitest";
import type { RepositoryCreateOption } from "./api";
import { parseForgeRepoFilter } from "./forge-repo-filter";

const baseRepo = (
	override: Partial<RepositoryCreateOption>,
): RepositoryCreateOption => ({
	id: "r-1",
	name: "Repo",
	...override,
});

describe("parseForgeRepoFilter", () => {
	it("returns null when repository is null", () => {
		expect(parseForgeRepoFilter(null)).toBeNull();
	});

	it("parses GitHub SSH remotes", () => {
		expect(
			parseForgeRepoFilter(
				baseRepo({
					forgeProvider: "github",
					remoteUrl: "git@github.com:owner/repo.git",
				}),
			),
		).toBe("owner/repo");
	});

	it("parses GitHub HTTPS remotes", () => {
		expect(
			parseForgeRepoFilter(
				baseRepo({
					forgeProvider: "github",
					remoteUrl: "https://github.com/owner/repo",
				}),
			),
		).toBe("owner/repo");
	});

	it("parses GitLab SSH remotes with nested namespace", () => {
		expect(
			parseForgeRepoFilter(
				baseRepo({
					forgeProvider: "gitlab",
					remoteUrl: "git@gitlab.com:group/sub/project.git",
				}),
			),
		).toBe("group/sub/project");
	});

	it("parses self-hosted GitLab", () => {
		expect(
			parseForgeRepoFilter(
				baseRepo({
					forgeProvider: "gitlab",
					remoteUrl: "https://gitlab.example.com/group/project.git",
				}),
			),
		).toBe("group/project");
	});

	it("falls back to GitHub when provider is unknown but host matches", () => {
		expect(
			parseForgeRepoFilter(
				baseRepo({
					forgeProvider: null,
					remoteUrl: "git@github.com:owner/repo.git",
				}),
			),
		).toBe("owner/repo");
	});

	it("returns null when the host does not match the declared forge", () => {
		expect(
			parseForgeRepoFilter(
				baseRepo({
					forgeProvider: "github",
					remoteUrl: "git@gitlab.com:owner/repo.git",
				}),
			),
		).toBeNull();
	});

	it("returns null when remote URL is missing", () => {
		expect(
			parseForgeRepoFilter(baseRepo({ forgeProvider: "github" })),
		).toBeNull();
	});

	it("ignores trailing slashes and .git suffix", () => {
		expect(
			parseForgeRepoFilter(
				baseRepo({
					forgeProvider: "github",
					remoteUrl: "https://github.com/owner/repo.git/",
				}),
			),
		).toBe("owner/repo");
	});
});
