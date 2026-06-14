import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";
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
				href: "http://localhost/",
			},
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists config, activates team mode, and reloads on success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ ok: true, memberId: "583231" }), {
					status: 200,
				}),
			),
		);

		const { result } = renderHook(() => useInviteAccept());
		let outcome: { ok: boolean; error: string | null } | undefined;
		await act(async () => {
			outcome = await result.current.accept(INVITE, IDENTITY);
		});

		expect(outcome?.ok).toBe(true);
		expect(getTeamConfig()).toEqual({
			url: "https://team.example.com",
			token: "tok-1",
		});
		expect(isTeamModeActive()).toBe(true);
		expect(reloadMock).toHaveBeenCalledOnce();
	});

	it("surfaces a 410 as the expired message and leaves config untouched", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("", { status: 410 })),
		);

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
