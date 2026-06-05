import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the companion transport's auth-state tracking (src/lib/ipc.ts).
// A browser with no — or a stale/revoked — pairing token must surface as
// "unauthed" so the shell renders the pairing screen instead of falling
// through to the onboarding flow (which shows demo workspaces).
//
// `isTauriRuntime()` is false under jsdom (no `__TAURI_INTERNALS__`), so setting
// `window.__HELMOR_COMPANION__` flips the module onto the HTTP/fetch path.
// `vi.resetModules()` re-evaluates the module-level `COMPANION` const per test.
describe("companion auth state", () => {
	const TOKEN_KEY = "helmor.companion.pat";
	type CompanionWindow = { __HELMOR_COMPANION__?: unknown };

	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = {
			base: "https://companion.test",
		};
	});

	afterEach(() => {
		(window as unknown as CompanionWindow).__HELMOR_COMPANION__ = undefined;
		vi.unstubAllGlobals();
		localStorage.clear();
	});

	it("is unauthed at boot when no pairing token is stored", async () => {
		const ipc = await import("./ipc");
		expect(ipc.getCompanionAuthState()).toBe("unauthed");
	});

	it("flips to unauthed when a request returns 401", async () => {
		localStorage.setItem(TOKEN_KEY, "hlm_stale");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: async () => "unauthorized",
			}),
		);

		const ipc = await import("./ipc");
		// A token is present but not yet verified against the server.
		expect(ipc.getCompanionAuthState()).toBe("unknown");

		await expect(ipc.invoke("list_workspace_groups")).rejects.toBeDefined();
		expect(ipc.getCompanionAuthState()).toBe("unauthed");
	});

	it("reports ok after a successful request and notifies subscribers", async () => {
		localStorage.setItem(TOKEN_KEY, "hlm_valid");
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ groups: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const ipc = await import("./ipc");
		await ipc.invoke("list_workspace_groups");
		expect(ipc.getCompanionAuthState()).toBe("ok");

		// A later 401 transition fires subscribers (drives the shell re-render).
		const listener = vi.fn();
		const unsub = ipc.subscribeCompanionAuth(listener);
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => "unauthorized",
		});
		await expect(ipc.invoke("list_workspace_groups")).rejects.toBeDefined();
		expect(listener).toHaveBeenCalled();
		expect(ipc.getCompanionAuthState()).toBe("unauthed");
		unsub();
	});
});
