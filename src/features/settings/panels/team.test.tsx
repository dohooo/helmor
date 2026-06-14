import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as teamSwitch from "@/lib/team-switch";
import { renderWithProviders } from "@/test/render-with-providers";
import { TeamPanel } from "./team";

function stubReload(): ReturnType<typeof vi.fn> {
	const reload = vi.fn();
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...window.location, reload },
	});
	return reload;
}

describe("TeamPanel", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("disables Test connection until a Worker URL is entered", () => {
		renderWithProviders(<TeamPanel />);

		const testButton = screen.getByRole("button", { name: /test connection/i });
		expect(testButton).toBeDisabled();

		fireEvent.change(screen.getByPlaceholderText(/workers\.dev/i), {
			target: { value: "https://team.example.com" },
		});
		expect(testButton).toBeEnabled();
	});

	it("pings /v1/health with the entered token on Test connection", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		renderWithProviders(<TeamPanel />);
		fireEvent.change(screen.getByPlaceholderText(/workers\.dev/i), {
			target: { value: "https://team.example.com" },
		});
		fireEvent.change(screen.getByPlaceholderText(/hlm_/), {
			target: { value: "hlm_secret" },
		});
		fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"https://team.example.com/v1/health",
				{ headers: { Authorization: "Bearer hlm_secret" } },
			),
		);
	});

	it("reflects the persisted active state in the toggle", () => {
		localStorage.setItem("helmor.team.url", "https://team.example.com");
		localStorage.setItem("helmor.team.token", "hlm_secret");
		localStorage.setItem("helmor.team.mode", "1");

		renderWithProviders(<TeamPanel />);
		expect(
			screen.getByRole("switch", { name: /toggle team mode/i }),
		).toBeChecked();
	});

	it("switches in place via switchTeamMode (no reload) when toggled on with a URL", () => {
		const reload = stubReload();
		const switchSpy = vi
			.spyOn(teamSwitch, "switchTeamMode")
			.mockImplementation(() => {});

		renderWithProviders(<TeamPanel />);
		fireEvent.change(screen.getByPlaceholderText(/workers\.dev/i), {
			target: { value: "https://team.example.com" },
		});
		fireEvent.change(screen.getByPlaceholderText(/hlm_/), {
			target: { value: "hlm_secret" },
		});
		fireEvent.click(screen.getByRole("switch", { name: /toggle team mode/i }));

		expect(switchSpy).toHaveBeenCalledWith({
			url: "https://team.example.com",
			token: "hlm_secret",
		});
		expect(reload).not.toHaveBeenCalled();
	});

	it("does not switch (and shows an error) when toggled on with no URL", () => {
		const switchSpy = vi
			.spyOn(teamSwitch, "switchTeamMode")
			.mockImplementation(() => {});

		renderWithProviders(<TeamPanel />);
		fireEvent.click(screen.getByRole("switch", { name: /toggle team mode/i }));

		expect(switchSpy).not.toHaveBeenCalled();
	});

	it("switches back to local via switchTeamMode(null) (no reload) when toggled off", () => {
		localStorage.setItem("helmor.team.url", "https://team.example.com");
		localStorage.setItem("helmor.team.token", "hlm_secret");
		localStorage.setItem("helmor.team.mode", "1");
		const reload = stubReload();
		const switchSpy = vi
			.spyOn(teamSwitch, "switchTeamMode")
			.mockImplementation(() => {});

		renderWithProviders(<TeamPanel />);
		fireEvent.click(screen.getByRole("switch", { name: /toggle team mode/i }));

		expect(switchSpy).toHaveBeenCalledWith(null);
		expect(reload).not.toHaveBeenCalled();
	});
});
