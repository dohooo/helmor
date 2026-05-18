import { test as base, type Page } from "@playwright/test";

// Shared Playwright fixture that boots the Helmor shell past its first-run
// gates so specs start from the main workspace surface:
//   - stubs `get_app_settings` to mark onboarding completed so the overlay
//     never appears
//   - exposes `window.__HELMOR_E2E__` as a hook for specs to override
//     individual invoke commands before the app boots

declare global {
	interface Window {
		__HELMOR_E2E__?: {
			invokeOverrides?: Record<string, (args?: unknown) => unknown>;
		};
	}
}

type HelmorFixtures = {
	app: Page;
};

export const test = base.extend<HelmorFixtures>({
	app: async ({ page }, use) => {
		await page.addInitScript(() => {
			window.__HELMOR_E2E__ = {
				invokeOverrides: {
					get_app_settings: () => ({ "app.onboarding_completed": "true" }),
				},
			};
		});

		await page.goto("/");
		await use(page);
	},
});

export { expect } from "@playwright/test";
