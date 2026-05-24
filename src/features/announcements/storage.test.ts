import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	dismissReleaseAnnouncement,
	isFirstHelmorBoot,
	LAST_DISMISSED_RELEASE_VERSION_STORAGE_KEY,
	LAST_SEEN_INSTALL_VERSION_STORAGE_KEY,
	readLastDismissedReleaseVersion,
	readLastSeenInstallVersion,
	writeLastSeenInstallVersion,
} from "./storage";

describe("dismissed-release-version storage", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when nothing is stored", () => {
		expect(readLastDismissedReleaseVersion()).toBeNull();
	});

	it("returns the persisted watermark version", () => {
		window.localStorage.setItem(
			LAST_DISMISSED_RELEASE_VERSION_STORAGE_KEY,
			"0.21.0",
		);
		expect(readLastDismissedReleaseVersion()).toBe("0.21.0");
	});

	it("dismissing a newer version raises the watermark", () => {
		dismissReleaseAnnouncement("0.20.0");
		dismissReleaseAnnouncement("0.21.0");
		expect(readLastDismissedReleaseVersion()).toBe("0.21.0");
	});

	it("dismissing an older version does not lower the watermark", () => {
		dismissReleaseAnnouncement("0.21.0");
		dismissReleaseAnnouncement("0.20.0");
		expect(readLastDismissedReleaseVersion()).toBe("0.21.0");
	});

	it("dismissing the same version twice is a no-op", () => {
		dismissReleaseAnnouncement("0.21.0");
		dismissReleaseAnnouncement("0.21.0");
		expect(readLastDismissedReleaseVersion()).toBe("0.21.0");
	});

	it("doesn't throw when localStorage.setItem fails", () => {
		const setItemSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("quota exceeded");
			});
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		expect(() => dismissReleaseAnnouncement("0.21.0")).not.toThrow();
		expect(consoleErrorSpy).toHaveBeenCalled();
		setItemSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});
});

describe("last-seen-install-version storage", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when nothing is stored", () => {
		expect(readLastSeenInstallVersion()).toBeNull();
	});

	it("returns the persisted version string", () => {
		window.localStorage.setItem(
			LAST_SEEN_INSTALL_VERSION_STORAGE_KEY,
			"0.20.3",
		);
		expect(readLastSeenInstallVersion()).toBe("0.20.3");
	});

	it("returns null for an empty string (treated as unset)", () => {
		window.localStorage.setItem(LAST_SEEN_INSTALL_VERSION_STORAGE_KEY, "");
		expect(readLastSeenInstallVersion()).toBeNull();
	});

	it("writes the version to localStorage", () => {
		writeLastSeenInstallVersion("0.21.0");
		expect(
			window.localStorage.getItem(LAST_SEEN_INSTALL_VERSION_STORAGE_KEY),
		).toBe("0.21.0");
	});

	it("doesn't throw when localStorage.setItem fails", () => {
		const setItemSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("quota exceeded");
			});
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		expect(() => writeLastSeenInstallVersion("0.21.0")).not.toThrow();
		expect(consoleErrorSpy).toHaveBeenCalled();
		setItemSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});
});

describe("isFirstHelmorBoot", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports true when no helmor-* keys exist", () => {
		expect(isFirstHelmorBoot()).toBe(true);
	});

	it("reports false when helmor-theme is set (existing user)", () => {
		window.localStorage.setItem("helmor-theme", "dark");
		expect(isFirstHelmorBoot()).toBe(false);
	});

	it("reports false when helmor-dark-theme is set (existing user)", () => {
		window.localStorage.setItem("helmor-dark-theme", "midnight");
		expect(isFirstHelmorBoot()).toBe(false);
	});

	it("reports false (fail-closed) when localStorage access throws", () => {
		// If storage is blocked, surface as 'not fresh' so the toast at
		// least attempts to render — silently classifying as fresh would
		// drop announcements for the very users whose state is unreadable.
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(isFirstHelmorBoot()).toBe(false);
	});
});
