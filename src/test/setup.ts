import "@testing-library/jest-dom/vitest";

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
