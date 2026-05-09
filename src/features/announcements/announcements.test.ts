import { describe, expect, it } from "vitest";
import {
	type PublishedReleaseAnnouncement,
	type ReleaseAnnouncementCatalogEntry,
	selectReleaseAnnouncement,
} from "./announcements";

const catalog: readonly ReleaseAnnouncementCatalogEntry[] = [
	{ id: "a", items: [{ text: "A" }] },
	{ id: "b", items: [{ text: "B" }] },
];

const published: readonly PublishedReleaseAnnouncement[] = [
	{ id: "a", releaseVersion: "0.20.0" },
	{ id: "b", releaseVersion: "0.20.0" },
];

describe("selectReleaseAnnouncement", () => {
	it("returns null on first launch (lastSeenVersion is null)", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: null,
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when the version has not changed since last boot", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.20.0",
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("returns the matching announcement on upgrade", () => {
		const result = selectReleaseAnnouncement({
			catalog,
			published,
			currentVersion: "0.20.0",
			lastSeenVersion: "0.19.1",
			dismissedIds: new Set(),
		});
		expect(result).toEqual({
			id: "a",
			version: "0.20.0",
			items: [{ text: "A" }],
		});
	});

	it("skips dismissed ids and returns the next match", () => {
		const result = selectReleaseAnnouncement({
			catalog,
			published,
			currentVersion: "0.20.0",
			lastSeenVersion: "0.19.1",
			dismissedIds: new Set(["a"]),
		});
		expect(result?.id).toBe("b");
	});

	it("returns null when every match for the current version is dismissed", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.19.1",
				dismissedIds: new Set(["a", "b"]),
			}),
		).toBeNull();
	});

	it("returns null when the current version has no published entry (skipped version)", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.21.0",
				lastSeenVersion: "0.19.1",
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when the published id has no matching catalog entry", () => {
		expect(
			selectReleaseAnnouncement({
				catalog: [],
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.19.1",
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when the catalog id has not been published yet", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published: [],
				currentVersion: "0.20.0",
				lastSeenVersion: "0.19.1",
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});
});
