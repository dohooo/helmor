import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as teamSwitch from "@/lib/team-switch";
import { renderWithProviders } from "@/test/render-with-providers";
import { TeamPanel } from "./team";

// These panel tests assert PRODUCTION behaviour (no auto-fill). `import.meta.env.DEV`
// is true under vitest, so disable the dev-only default that would otherwise
// pre-fill the URL/token fields.
vi.mock("@/lib/team-mode", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/team-mode")>()),
	getDevTeamDefault: () => null,
}));

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

	// The Team-mode toggle was removed (the workspace-location switch owns
	// Local<->Team now). The panel keeps Join + an Advanced manual-connect path.

	it("disables Test until a Worker URL is entered (Advanced)", () => {
		renderWithProviders(<TeamPanel />);

		const testButton = screen.getByRole("button", { name: /^test$/i });
		expect(testButton).toBeDisabled();

		fireEvent.change(screen.getByPlaceholderText(/workers\.dev/i), {
			target: { value: "https://team.example.com" },
		});
		expect(testButton).toBeEnabled();
	});

	it("pings /v1/health with the entered token on Test", async () => {
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
		fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"https://team.example.com/v1/health",
				{ headers: { Authorization: "Bearer hlm_secret" } },
			),
		);
	});

	it("Connect switches in place via switchTeamMode (no reload) with a URL", () => {
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
		fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

		expect(switchSpy).toHaveBeenCalledWith({
			url: "https://team.example.com",
			token: "hlm_secret",
		});
		expect(reload).not.toHaveBeenCalled();
	});

	it("disables Connect until a Worker URL is entered", () => {
		const switchSpy = vi
			.spyOn(teamSwitch, "switchTeamMode")
			.mockImplementation(() => {});

		renderWithProviders(<TeamPanel />);
		expect(screen.getByRole("button", { name: /^connect$/i })).toBeDisabled();
		expect(switchSpy).not.toHaveBeenCalled();
	});
});
