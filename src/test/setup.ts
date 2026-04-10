import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => () => {}),
}));

// `src/lib/api.ts` always calls `invoke` from `@tauri-apps/api/core` now —
// there is no browser-mode fallback layer anymore. jsdom has no Tauri runtime,
// so without this mock every test that triggers a real API function (via
// importOriginal in its own vi.mock setup) would throw and cascade into
// cleared workspace state. Return sensible defaults for the handful of
// commands the boot path hits; individual tests still mock `./lib/api`
// directly when they need specific return values.
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (command: string) => {
		switch (command) {
			case "get_github_identity_session":
				return {
					status: "connected",
					session: {
						provider: "test",
						githubUserId: 0,
						login: "test",
						name: "Test User",
						avatarUrl: null,
						primaryEmail: null,
						tokenExpiresAt: null,
						refreshTokenExpiresAt: null,
					},
				};
			case "get_github_cli_status":
				return {
					status: "ready",
					host: "github.com",
					login: "test",
					version: "test",
					message: "ok",
				};
			case "get_github_cli_user":
				return {
					login: "test",
					id: 0,
					name: "Test",
					avatarUrl: null,
					email: null,
				};
			case "list_github_accessible_repositories":
				return [];
			case "get_add_repository_defaults":
				return { lastCloneDirectory: null };
			case "get_data_info":
				return null;
			case "list_remote_branches":
				return [];
			case "conductor_source_available":
				return false;
			default:
				return undefined;
		}
	}),
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
}));

// cmdk calls `scrollIntoView` which jsdom doesn't implement.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

if (
	typeof window !== "undefined" &&
	typeof window.ResizeObserver === "undefined"
) {
	class ResizeObserverMock {
		observe() {}
		unobserve() {}
		disconnect() {}
	}

	// JSDOM does not provide ResizeObserver.
	window.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
	globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
}

if (typeof HTMLCanvasElement !== "undefined") {
	Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
		configurable: true,
		value: vi.fn(() => ({
			measureText: (text: string) => ({
				width: text.length * 8,
				actualBoundingBoxAscent: 10,
				actualBoundingBoxDescent: 4,
				fontBoundingBoxAscent: 10,
				fontBoundingBoxDescent: 4,
			}),
			save: () => {},
			restore: () => {},
			scale: () => {},
			clearRect: () => {},
			fillRect: () => {},
			setTransform: () => {},
			resetTransform: () => {},
			beginPath: () => {},
			moveTo: () => {},
			lineTo: () => {},
			stroke: () => {},
			fillText: () => {},
			font: "",
			textBaseline: "alphabetic",
		})),
	});
}
