import { describe, expect, it } from "vitest";
import {
	type ReleaseAnnouncementCatalogEntry,
	selectReleaseAnnouncement,
} from "./announcements";

const catalog: readonly ReleaseAnnouncementCatalogEntry[] = [
	{
		releaseVersion: "0.20.0",
		items: [{ text: "A" }, { text: "B" }],
	},
];

describe("selectReleaseAnnouncement", () => {
	it("returns null on a genuine first install (isFirstHelmorBoot=true)", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				currentVersion: "0.20.0",
				lastSeenVersion: null,
				isFirstHelmorBoot: true,
				lastDismissedReleaseVersion: null,
			}),
		).toBeNull();
	});

	it("replays everything on an existing user's first boot with the announcement system", () => {
		const result = selectReleaseAnnouncement({
			catalog,
			currentVersion: "0.20.0",
			lastSeenVersion: null,
			isFirstHelmorBoot: false,
			lastDismissedReleaseVersion: null,
		});
		expect(result?.releaseVersions).toEqual(["0.20.0"]);
		expect(result?.items).toEqual([{ text: "A" }, { text: "B" }]);
	});

	it("returns null when the version has not changed since last boot", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.20.0",
				isFirstHelmorBoot: false,
				lastDismissedReleaseVersion: null,
			}),
		).toBeNull();
	});

	it("returns null when the user is on an older version than lastSeen", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				currentVersion: "0.19.0",
				lastSeenVersion: "0.20.0",
				isFirstHelmorBoot: false,
				lastDismissedReleaseVersion: null,
			}),
		).toBeNull();
	});

	it("returns one announcement for every undismissed item in the release", () => {
		const result = selectReleaseAnnouncement({
			catalog,
			currentVersion: "0.20.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			lastDismissedReleaseVersion: null,
		});
		expect(result).toEqual({
			releaseVersions: ["0.20.0"],
			version: "0.20.0",
			items: [{ text: "A" }, { text: "B" }],
		});
	});

	it("skips releases ≤ the dismissed watermark", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.19.1",
				isFirstHelmorBoot: false,
				lastDismissedReleaseVersion: "0.20.0",
			}),
		).toBeNull();
	});

	it("collapses older versions under a newer dismiss watermark", () => {
		const wideCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ releaseVersion: "0.19.0", items: [{ text: "OLD" }] },
			{ releaseVersion: "0.20.0", items: [{ text: "MID" }] },
			{ releaseVersion: "0.21.0", items: [{ text: "NEW" }] },
		];
		const result = selectReleaseAnnouncement({
			catalog: wideCatalog,
			currentVersion: "0.21.0",
			lastSeenVersion: "0.18.0",
			isFirstHelmorBoot: false,
			lastDismissedReleaseVersion: "0.20.0",
		});
		expect(result?.releaseVersions).toEqual(["0.21.0"]);
		expect(result?.items).toEqual([{ text: "NEW" }]);
	});

	it("replays every version in (lastSeen, current] when the user skipped releases", () => {
		const wideCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ releaseVersion: "0.20.0", items: [{ text: "A" }] },
			{ releaseVersion: "0.21.0", items: [{ text: "C" }] },
		];
		const result = selectReleaseAnnouncement({
			catalog: wideCatalog,
			currentVersion: "0.21.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			lastDismissedReleaseVersion: null,
		});
		expect(result).toEqual({
			releaseVersions: ["0.21.0", "0.20.0"],
			version: "0.21.0",
			items: [{ text: "C" }, { text: "A" }],
		});
	});

	it("does not fold in entries newer than the current version", () => {
		const futureCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ releaseVersion: "0.20.0", items: [{ text: "A" }] },
			{ releaseVersion: "0.21.0", items: [{ text: "FUTURE" }] },
		];
		const result = selectReleaseAnnouncement({
			catalog: futureCatalog,
			currentVersion: "0.20.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			lastDismissedReleaseVersion: null,
		});
		expect(result?.releaseVersions).toEqual(["0.20.0"]);
	});

	it("orders items by release version descending", () => {
		const orderedCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ releaseVersion: "0.20.0", items: [{ text: "OLDER" }] },
			{ releaseVersion: "0.21.0", items: [{ text: "NEWER" }] },
		];
		const result = selectReleaseAnnouncement({
			catalog: orderedCatalog,
			currentVersion: "0.21.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			lastDismissedReleaseVersion: null,
		});
		expect(result?.releaseVersions).toEqual(["0.21.0", "0.20.0"]);
		expect(result?.items).toEqual([{ text: "NEWER" }, { text: "OLDER" }]);
	});

	it("returns null when there is no catalog entry in the upgrade range", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				currentVersion: "0.21.0",
				lastSeenVersion: "0.20.0",
				isFirstHelmorBoot: false,
				lastDismissedReleaseVersion: null,
			}),
		).toBeNull();
	});
});
