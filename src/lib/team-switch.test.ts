import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "@/lib/ipc";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import * as transportGeneration from "@/lib/transport-generation";
import { switchTeamMode } from "./team-switch";

// Keep `applyTransportSwitch`'s real teardown out of the way — these tests
// assert the orchestration (persist → repoint → bump), not the transport guts
// (covered in ipc.test.ts).
vi.mock("@/lib/platform", () => ({
	isMac: () => true,
	isTauriRuntime: () => true,
}));

describe("switchTeamMode", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("persists config, flips the flag, repoints the transport, and bumps the generation (in order)", () => {
		const applySpy = vi.spyOn(ipc, "applyTransportSwitch");
		const bumpSpy = vi.spyOn(transportGeneration, "bumpTransportGeneration");

		switchTeamMode({ url: "https://team.example.com/", token: " hlm_x " });

		// Persistence (trailing slash stripped, token trimmed) + flag on.
		expect(getTeamConfig()).toEqual({
			url: "https://team.example.com",
			token: "hlm_x",
		});
		expect(isTeamModeActive()).toBe(true);

		// Both effects fired exactly once, transport BEFORE the remount bump.
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(bumpSpy).toHaveBeenCalledTimes(1);
		expect(applySpy.mock.invocationCallOrder[0]).toBeLessThan(
			bumpSpy.mock.invocationCallOrder[0],
		);
		// The transport reflects the new truth when applyTransportSwitch runs.
		expect(ipc.isRemoteTransport()).toBe(true);
	});

	it("switchTeamMode(null) clears the flag and repoints to local", () => {
		// Start configured + active.
		localStorage.setItem("helmor.team.url", "https://team.example.com");
		localStorage.setItem("helmor.team.token", "hlm_secret");
		localStorage.setItem("helmor.team.mode", "1");

		const applySpy = vi.spyOn(ipc, "applyTransportSwitch");
		const bumpSpy = vi.spyOn(transportGeneration, "bumpTransportGeneration");

		switchTeamMode(null);

		expect(isTeamModeActive()).toBe(false);
		// Config (url/token) is left untouched — only the mode flag flips off, so
		// re-enabling later doesn't require re-entering the backend.
		expect(localStorage.getItem("helmor.team.url")).toBe(
			"https://team.example.com",
		);
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(bumpSpy).toHaveBeenCalledTimes(1);
		expect(ipc.isRemoteTransport()).toBe(false);
	});

	it("does not call window.location.reload", () => {
		const reload = vi.fn();
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...window.location, reload },
		});
		switchTeamMode({ url: "https://team.example.com", token: "" });
		expect(reload).not.toHaveBeenCalled();
	});
});
