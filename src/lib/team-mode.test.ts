import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getTeamConfig,
	isTeamModeActive,
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
