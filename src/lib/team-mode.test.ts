import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearInviteFromLocation,
	getInviteFromLocation,
	getTeamConfig,
	isTeamModeActive,
	parseInviteLink,
	pingTeamBackend,
	saveTeamConfig,
	setTeamModeActive,
} from "./team-mode";

describe("team-mode config", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("returns null until a Worker URL is saved", () => {
		expect(getTeamConfig()).toBeNull();
		expect(isTeamModeActive()).toBe(false);
	});

	it("round-trips config and strips the trailing slash", () => {
		saveTeamConfig({ url: "https://team.example.com/", token: " hlm_abc " });
		expect(getTeamConfig()).toEqual({
			url: "https://team.example.com",
			token: "hlm_abc",
		});
	});

	it("only reports active when the flag is set AND a URL exists", () => {
		// Flag on, no URL → not active.
		setTeamModeActive(true);
		expect(isTeamModeActive()).toBe(false);

		// URL saved but flag off → not active.
		saveTeamConfig({ url: "https://team.example.com", token: "" });
		setTeamModeActive(false);
		expect(isTeamModeActive()).toBe(false);

		// Both → active.
		setTeamModeActive(true);
		expect(isTeamModeActive()).toBe(true);
	});
});

describe("pingTeamBackend", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hits /v1/health with a bearer token and reports 2xx as reachable", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			pingTeamBackend("https://team.example.com/", "hlm_tok"),
		).resolves.toBe(true);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://team.example.com/v1/health",
			{
				headers: { Authorization: "Bearer hlm_tok" },
			},
		);
	});

	it("reports non-2xx as unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
		);
		await expect(
			pingTeamBackend("https://team.example.com", "hlm_tok"),
		).resolves.toBe(false);
	});

	it("swallows network errors and reports unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("network down")),
		);
		await expect(pingTeamBackend("https://team.example.com", "")).resolves.toBe(
			false,
		);
	});

	it("returns false for an empty URL without calling fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(pingTeamBackend("   ", "tok")).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("parseInviteLink", () => {
	it("extracts origin + token from a control-plane invite link", () => {
		expect(
			parseInviteLink("https://helmor-team.example.workers.dev/?invite=abc123"),
		).toEqual({
			url: "https://helmor-team.example.workers.dev",
			token: "abc123",
		});
	});

	it("drops any path and extra query params, keeping only the origin", () => {
		const parsed = parseInviteLink(
			"https://team.example.com/join/x?invite=tok&foo=bar",
		);
		expect(parsed?.url).toBe("https://team.example.com");
		expect(parsed?.token).toBe("tok");
	});

	it("trims surrounding whitespace", () => {
		expect(
			parseInviteLink("  https://t.example.com/?invite=tok  ")?.token,
		).toBe("tok");
	});

	it("returns null when the invite param is missing or blank", () => {
		expect(parseInviteLink("https://team.example.com/")).toBeNull();
		expect(parseInviteLink("https://team.example.com/?invite=")).toBeNull();
		expect(parseInviteLink("https://team.example.com/?invite=%20")).toBeNull();
	});

	it("returns null for a non-URL string (e.g. a bare token)", () => {
		expect(parseInviteLink("abc123")).toBeNull();
		expect(parseInviteLink("")).toBeNull();
	});
});

describe("invite location helpers", () => {
	const originalHref = window.location.href;

	afterEach(() => {
		window.history.replaceState(null, "", originalHref);
	});

	it("getInviteFromLocation reads the invite out of window.location", () => {
		window.history.replaceState(null, "", "/?invite=loc-token");
		const parsed = getInviteFromLocation();
		expect(parsed?.token).toBe("loc-token");
		expect(parsed?.url).toBe(window.location.origin);
	});

	it("getInviteFromLocation returns null when no invite param is present", () => {
		window.history.replaceState(null, "", "/");
		expect(getInviteFromLocation()).toBeNull();
	});

	it("clearInviteFromLocation strips the invite param", () => {
		window.history.replaceState(null, "", "/?invite=loc-token&keep=1");
		clearInviteFromLocation();
		expect(window.location.search).toBe("?keep=1");
		expect(getInviteFromLocation()).toBeNull();
	});
});
