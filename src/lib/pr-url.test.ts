import { describe, expect, it } from "vitest";
import { parsePrUrl } from "./pr-url";

describe("parsePrUrl", () => {
	it("parses GitHub PR URLs", () => {
		expect(parsePrUrl("https://github.com/acme/widgets/pull/42")).toEqual({
			number: 42,
			provider: "github",
		});
	});

	it("parses GitHub Enterprise PR URLs", () => {
		expect(
			parsePrUrl("https://git.corp.example.com/acme/widgets/pull/7"),
		).toEqual({
			number: 7,
			provider: "github",
		});
	});

	it("parses GitLab MR URLs", () => {
		expect(
			parsePrUrl("https://gitlab.com/acme/widgets/-/merge_requests/123"),
		).toEqual({ number: 123, provider: "gitlab" });
	});

	it("parses self-hosted GitLab MR URLs", () => {
		expect(
			parsePrUrl("https://gitlab.internal/group/sub/repo/-/merge_requests/9"),
		).toEqual({ number: 9, provider: "gitlab" });
	});

	it("tolerates trailing query / fragment / files segments", () => {
		expect(parsePrUrl("https://github.com/a/b/pull/12/files")).toEqual({
			number: 12,
			provider: "github",
		});
		expect(parsePrUrl("https://github.com/a/b/pull/12?foo=bar")).toEqual({
			number: 12,
			provider: "github",
		});
		expect(
			parsePrUrl("https://gitlab.com/a/b/-/merge_requests/3#note_1"),
		).toEqual({ number: 3, provider: "gitlab" });
	});

	it("returns null for non-PR URLs", () => {
		expect(parsePrUrl("https://github.com/acme/widgets")).toBeNull();
		expect(parsePrUrl("https://example.com/")).toBeNull();
		expect(parsePrUrl("")).toBeNull();
		expect(parsePrUrl(null)).toBeNull();
		expect(parsePrUrl(undefined)).toBeNull();
	});

	it("returns null for malformed PR numbers", () => {
		expect(parsePrUrl("https://github.com/a/b/pull/abc")).toBeNull();
		expect(parsePrUrl("https://gitlab.com/a/b/-/merge_requests/0")).toBeNull();
	});
});
