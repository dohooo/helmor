import { describe, expect, it } from "bun:test";

import type { NativePairing } from "../lib/pairing";
import { resolveMobileShellRoute } from "./mobile-shell-state";

const pairing: NativePairing = {
	baseUrl: "https://desktop.example",
	originalUrl: "helmor://pair?baseUrl=https%3A%2F%2Fdesktop.example&pair=token",
	pairedAt: "2026-06-09T00:00:00.000Z",
	token: "token",
};

describe("resolveMobileShellRoute", () => {
	it("shows booting before any other route", () => {
		expect(
			resolveMobileShellRoute({
				booting: true,
				onboardingCompleted: false,
				pairing,
			}),
		).toBe("booting");
	});

	it("shows the paired webview when pairing exists", () => {
		expect(
			resolveMobileShellRoute({
				booting: false,
				onboardingCompleted: false,
				pairing,
			}),
		).toBe("paired");
	});

	it("shows onboarding for first-time unpaired users", () => {
		expect(
			resolveMobileShellRoute({
				booting: false,
				onboardingCompleted: false,
				pairing: null,
			}),
		).toBe("onboarding");
	});

	it("shows the connection guide for completed unpaired users", () => {
		expect(
			resolveMobileShellRoute({
				booting: false,
				onboardingCompleted: true,
				pairing: null,
			}),
		).toBe("connectionGuide");
	});
});
