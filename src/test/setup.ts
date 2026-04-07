import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => () => {}),
}));

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
