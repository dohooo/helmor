import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
	dismissReleaseAnnouncement,
	isFirstHelmorBoot,
	LAST_SEEN_INSTALL_VERSION_STORAGE_KEY,
	readDismissedReleaseAnnouncementVersions,
	readLastSeenInstallVersion,
	writeLastSeenInstallVersion,
} from "./storage";

describe("dismissed-announcements storage", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("returns an empty set when nothing is stored", () => {
		expect(readDismissedReleaseAnnouncementVersions().size).toBe(0);
	});

	it("returns the persisted versions as a Set", () => {
		window.localStorage.setItem(
			DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
			JSON.stringify(["0.20.0", "0.21.0"]),
		);
		const dismissed = readDismissedReleaseAnnouncementVersions();
		expect([...dismissed].sort()).toEqual(["0.20.0", "0.21.0"]);
	});

	it("maps legacy dismissed ids to their release versions", () => {
		window.localStorage.setItem(
			DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
			JSON.stringify(["2026-05-11-2300"]),
		);
		expect([...readDismissedReleaseAnnouncementVersions()]).toEqual(["0.21.0"]);
	});

	it("recovers gracefully from invalid JSON", () => {
		window.localStorage.setItem(
			DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
			"{not json",
		);
		expect(readDismissedReleaseAnnouncementVersions().size).toBe(0);
	});

	it("ignores non-array stored values", () => {
		window.localStorage.setItem(
			DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
			JSON.stringify({ rogue: "shape" }),
		);
		expect(readDismissedReleaseAnnouncementVersions().size).toBe(0);
	});

	it("filters out non-string entries from the persisted array", () => {
		window.localStorage.setItem(
			DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
			JSON.stringify(["valid", 42, null, "also-valid"]),
		);
		expect([...readDismissedReleaseAnnouncementVersions()].sort()).toEqual([
			"also-valid",
			"valid",
		]);
	});

	it("appends a version without losing previously dismissed ones", () => {
		dismissReleaseAnnouncement("0.20.0");
		dismissReleaseAnnouncement("0.21.0");
		expect([...readDismissedReleaseAnnouncementVersions()].sort()).toEqual([
			"0.20.0",
			"0.21.0",
		]);
	});

	it("is idempotent — dismissing the same version twice doesn't duplicate it", () => {
		dismissReleaseAnnouncement("0.21.0");
		dismissReleaseAnnouncement("0.21.0");
		const dismissed = readDismissedReleaseAnnouncementVersions();
		expect(dismissed.size).toBe(1);
		expect(dismissed.has("0.21.0")).toBe(true);
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
		expect(() => dismissReleaseAnnouncement("x")).not.toThrow();
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
