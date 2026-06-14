import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as teamMode from "@/lib/team-mode";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
import * as teamSwitch from "@/lib/team-switch";
import { ACCEPT_ERROR_MESSAGES, useInviteAccept } from "./use-invite-accept";

const INVITE = { url: "https://team.example.com", token: "tok-1" };
const IDENTITY = {
	githubId: "583231",
	login: "octocat",
	avatarUrl: "https://a/u",
	displayName: "The Octocat",
};

describe("useInviteAccept", () => {
	let reloadMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		localStorage.clear();
		reloadMock = vi.fn();
		// jsdom's location.reload is a non-configurable noop; redefine it.
		Object.defineProperty(window, "location", {
			value: {
				...window.location,
				reload: reloadMock,
				href: "http://localhost/?invite=tok-1",
				search: "?invite=tok-1",
			},
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists config, activates team mode IN PLACE (no reload) on success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ ok: true, memberId: "583231" }), {
					status: 200,
				}),
			),
		);
		const switchSpy = vi.spyOn(teamSwitch, "switchTeamMode");
		const clearSpy = vi.spyOn(teamMode, "clearInviteFromLocation");

		const { result } = renderHook(() => useInviteAccept());
		let outcome: { ok: boolean; error: string | null } | undefined;
		await act(async () => {
			outcome = await result.current.accept(INVITE, IDENTITY);
		});

		expect(outcome?.ok).toBe(true);
		// switchTeamMode persists config + flips the flag (observable effects).
		expect(getTeamConfig()).toEqual({
			url: "https://team.example.com",
			token: "tok-1",
		});
		expect(isTeamModeActive()).toBe(true);
		expect(switchSpy).toHaveBeenCalledWith({
			url: "https://team.example.com",
			token: "tok-1",
		});
		// The invite param is stripped BEFORE the switch (no reload to drop it).
		expect(clearSpy).toHaveBeenCalledTimes(1);
		const clearOrder = clearSpy.mock.invocationCallOrder[0];
		const switchOrder = switchSpy.mock.invocationCallOrder[0];
		expect(clearOrder).toBeLessThan(switchOrder);
		// Instant switch — never a page reload.
		expect(reloadMock).not.toHaveBeenCalled();
	});

	it("surfaces a 410 as the expired message and leaves config untouched", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("", { status: 410 })),
		);
		const switchSpy = vi.spyOn(teamSwitch, "switchTeamMode");

		const { result } = renderHook(() => useInviteAccept());
		let outcome: { ok: boolean; error: string | null } | undefined;
		await act(async () => {
			outcome = await result.current.accept(INVITE, IDENTITY);
		});

		expect(outcome?.ok).toBe(false);
		expect(outcome?.error).toBe(ACCEPT_ERROR_MESSAGES.expired);
		expect(result.current.status).toBe("error");
		expect(result.current.errorMessage).toBe(ACCEPT_ERROR_MESSAGES.expired);
		// No side effects on failure.
		expect(getTeamConfig()).toBeNull();
		expect(isTeamModeActive()).toBe(false);
		expect(switchSpy).not.toHaveBeenCalled();
		expect(reloadMock).not.toHaveBeenCalled();
	});

	it("surfaces a network failure", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

		const { result } = renderHook(() => useInviteAccept());
		let outcome: { ok: boolean; error: string | null } | undefined;
		await act(async () => {
			outcome = await result.current.accept(INVITE, IDENTITY);
		});

		expect(outcome?.error).toBe(ACCEPT_ERROR_MESSAGES.network);
	});
});
