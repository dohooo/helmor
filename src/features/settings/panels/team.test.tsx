import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { TeamPanel } from "./team";

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
});
