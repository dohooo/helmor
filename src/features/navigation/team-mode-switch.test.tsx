import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as teamSwitch from "@/lib/team-switch";
import { renderWithProviders } from "@/test/render-with-providers";
import { TeamModeSwitch } from "./team-mode-switch";

// The switch is desktop-only; pretend we're inside the Tauri webview.
vi.mock("@/lib/platform", () => ({
	isMac: () => true,
	isTauriRuntime: () => true,
}));

function stubReload(): ReturnType<typeof vi.fn> {
	const reload = vi.fn();
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...window.location, reload },
	});
	return reload;
}

describe("TeamModeSwitch", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("shows the local label by default", () => {
		renderWithProviders(<TeamModeSwitch />);
		expect(
			screen.getByRole("button", { name: /workspace location/i }),
		).toBeInTheDocument();
	});

	it("routes to the Team settings panel when Team is picked unconfigured", async () => {
		const user = userEvent.setup();
		const reload = stubReload();
		const switchSpy = vi.spyOn(teamSwitch, "switchTeamMode");
		const onOpenSettings = vi.fn();
		window.addEventListener("helmor:open-settings", onOpenSettings);

		renderWithProviders(<TeamModeSwitch />);
		await user.click(
			screen.getByRole("button", { name: /workspace location/i }),
		);
		await user.click(screen.getByRole("menuitem", { name: /^team$/i }));

		expect(onOpenSettings).toHaveBeenCalledTimes(1);
		// Unconfigured Team must NOT switch (it routes to settings instead) and
		// must never reload.
		expect(switchSpy).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		window.removeEventListener("helmor:open-settings", onOpenSettings);
	});

	it("activates team mode in place (no reload) when a backend is configured", async () => {
		const user = userEvent.setup();
		localStorage.setItem("helmor.team.url", "https://team.example.com");
		localStorage.setItem("helmor.team.token", "hlm_secret");
		const reload = stubReload();
		const switchSpy = vi.spyOn(teamSwitch, "switchTeamMode");

		renderWithProviders(<TeamModeSwitch />);
		await user.click(
			screen.getByRole("button", { name: /workspace location/i }),
		);
		await user.click(screen.getByRole("menuitem", { name: /^team$/i }));

		await waitFor(() =>
			expect(switchSpy).toHaveBeenCalledWith({
				url: "https://team.example.com",
				token: "hlm_secret",
			}),
		);
		// Instant switch — never a page reload.
		expect(reload).not.toHaveBeenCalled();
		expect(localStorage.getItem("helmor.team.mode")).toBe("1");
	});

	it("switches back to local in place (no reload) when currently in team mode", async () => {
		const user = userEvent.setup();
		localStorage.setItem("helmor.team.url", "https://team.example.com");
		localStorage.setItem("helmor.team.token", "hlm_secret");
		localStorage.setItem("helmor.team.mode", "1");
		const reload = stubReload();
		const switchSpy = vi.spyOn(teamSwitch, "switchTeamMode");

		renderWithProviders(<TeamModeSwitch />);
		await user.click(
			screen.getByRole("button", { name: /workspace location/i }),
		);
		await user.click(screen.getByRole("menuitem", { name: /^local$/i }));

		await waitFor(() => expect(switchSpy).toHaveBeenCalledWith(null));
		expect(reload).not.toHaveBeenCalled();
		expect(localStorage.getItem("helmor.team.mode")).toBeNull();
	});
});
