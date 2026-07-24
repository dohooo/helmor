import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearInviteFromLocation,
	clearTeamConfig,
	getCodexIdentityEmail,
	getInviteFromLocation,
	getTeamAdminToken,
	getTeamConfig,
	isTeamAdmin,
	isTeamModeActive,
	parseInviteLink,
	saveCodexIdentityEmail,
	saveTeamAdminToken,
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

describe("admin token + role (R5-A)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("is not admin without a stored admin token", () => {
		saveTeamConfig({ url: "https://team.example.com", token: "member" });
		setTeamModeActive(true);
		expect(getTeamAdminToken()).toBeNull();
		expect(isTeamAdmin()).toBe(false);
	});

	it("is admin only when team mode is active AND an admin token exists", () => {
		saveTeamAdminToken(" hlm_admin_1 ");
		expect(getTeamAdminToken()).toBe("hlm_admin_1");
		// Admin token alone isn't enough — team mode must be active.
		expect(isTeamAdmin()).toBe(false);

		saveTeamConfig({ url: "https://team.example.com", token: "member" });
		setTeamModeActive(true);
		expect(isTeamAdmin()).toBe(true);
	});

	it("ignores empty admin tokens", () => {
		saveTeamAdminToken("   ");
		expect(getTeamAdminToken()).toBeNull();
	});
});

describe("codex identity email (R5-A)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("round-trips the captured email", () => {
		expect(getCodexIdentityEmail()).toBeNull();
		saveCodexIdentityEmail(" dev@example.com ");
		expect(getCodexIdentityEmail()).toBe("dev@example.com");
	});

	it("ignores empty emails", () => {
		saveCodexIdentityEmail("   ");
		expect(getCodexIdentityEmail()).toBeNull();
	});
});

describe("clearTeamConfig (R5-A leave-team semantics)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("wipes config, mode flag, admin token, and cached email", () => {
		saveTeamConfig({ url: "https://team.example.com", token: "member" });
		setTeamModeActive(true);
		saveTeamAdminToken("hlm_admin_1");
		saveCodexIdentityEmail("dev@example.com");

		clearTeamConfig();

		expect(getTeamConfig()).toBeNull();
		expect(isTeamModeActive()).toBe(false);
		expect(getTeamAdminToken()).toBeNull();
		expect(getCodexIdentityEmail()).toBeNull();
		expect(isTeamAdmin()).toBe(false);
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
