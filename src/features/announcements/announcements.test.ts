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
	it("returns null on a genuine first install (isFirstHelmorBoot=true)", () => {
		// No prior version recorded AND no other Helmor trace on the
		// device: this is a brand-new install. Don't lead with a "what's
		// new in vX" toast for a user who has nothing old to compare
		// against.
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: null,
				isFirstHelmorBoot: true,
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("replays everything on an existing user's first boot with the announcement system", () => {
		// Existing user picking up the announcement system for the first
		// time. The lastSeen storage key is brand-new (so it's null), but
		// the user has used previous Helmor builds — `isFirstHelmorBoot`
		// reports false. The selector should treat the upgrade range as
		// (0.0.0, currentVersion] and replay every published entry,
		// otherwise the launch toast is invisible to every existing
		// user — the very people we want to teach.
		const result = selectReleaseAnnouncement({
			catalog,
			published,
			currentVersion: "0.20.0",
			lastSeenVersion: null,
			isFirstHelmorBoot: false,
			dismissedIds: new Set(),
		});
		expect(result?.ids).toEqual(["a", "b"]);
		expect(result?.items).toEqual([{ text: "A" }, { text: "B" }]);
	});

	it("returns null when the version has not changed since last boot", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.20.0",
				isFirstHelmorBoot: false,
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when the user is on an OLDER version than lastSeen (downgrade)", () => {
		// Defensive: a downgrade has no upgrade story to tell.
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.19.0",
				lastSeenVersion: "0.20.0",
				isFirstHelmorBoot: false,
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("merges every undismissed entry from the same version into one announcement", () => {
		const result = selectReleaseAnnouncement({
			catalog,
			published,
			currentVersion: "0.20.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			dismissedIds: new Set(),
		});
		expect(result).toEqual({
			ids: ["a", "b"],
			version: "0.20.0",
			items: [{ text: "A" }, { text: "B" }],
		});
	});

	it("skips dismissed ids while keeping the rest", () => {
		const result = selectReleaseAnnouncement({
			catalog,
			published,
			currentVersion: "0.20.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			dismissedIds: new Set(["a"]),
		});
		expect(result?.ids).toEqual(["b"]);
		expect(result?.items).toEqual([{ text: "B" }]);
	});

	it("returns null when every entry in range is dismissed", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.19.1",
				isFirstHelmorBoot: false,
				dismissedIds: new Set(["a", "b"]),
			}),
		).toBeNull();
	});

	it("replays every version in (lastSeen, current] when the user skipped releases", () => {
		// User jumped 0.19.1 → 0.21.0, missing 0.20.0 entirely. The 0.20.0
		// entries should be folded in alongside 0.21.0's content, newest
		// first (0.21.0 → 0.20.0), and the toast header should read v0.21.0.
		const wideCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ id: "a", items: [{ text: "A" }] },
			{ id: "c", items: [{ text: "C" }] },
		];
		const widePublished: readonly PublishedReleaseAnnouncement[] = [
			{ id: "a", releaseVersion: "0.20.0" },
			{ id: "c", releaseVersion: "0.21.0" },
		];
		const result = selectReleaseAnnouncement({
			catalog: wideCatalog,
			published: widePublished,
			currentVersion: "0.21.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			dismissedIds: new Set(),
		});
		expect(result).toEqual({
			ids: ["c", "a"],
			version: "0.21.0",
			items: [{ text: "C" }, { text: "A" }],
		});
	});

	it("does NOT fold in entries newer than the current version", () => {
		// The user is on 0.20.0; a future 0.21.0 entry sitting in
		// `published` (e.g. from a prerelease build's leaked artifact)
		// must not leak into the toast.
		const futureCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ id: "a", items: [{ text: "A" }] },
			{ id: "future", items: [{ text: "FUTURE" }] },
		];
		const futurePublished: readonly PublishedReleaseAnnouncement[] = [
			{ id: "a", releaseVersion: "0.20.0" },
			{ id: "future", releaseVersion: "0.21.0" },
		];
		const result = selectReleaseAnnouncement({
			catalog: futureCatalog,
			published: futurePublished,
			currentVersion: "0.20.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			dismissedIds: new Set(),
		});
		expect(result?.ids).toEqual(["a"]);
	});

	it("orders items by release version descending (newest first)", () => {
		const orderedCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ id: "newer", items: [{ text: "NEWER" }] },
			{ id: "older", items: [{ text: "OLDER" }] },
		];
		// Deliberately list older first in `published` — selector must
		// still sort by releaseVersion descending so newest content sits
		// at the top of the toast.
		const orderedPublished: readonly PublishedReleaseAnnouncement[] = [
			{ id: "older", releaseVersion: "0.20.0" },
			{ id: "newer", releaseVersion: "0.21.0" },
		];
		const result = selectReleaseAnnouncement({
			catalog: orderedCatalog,
			published: orderedPublished,
			currentVersion: "0.21.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			dismissedIds: new Set(),
		});
		expect(result?.ids).toEqual(["newer", "older"]);
		expect(result?.items).toEqual([{ text: "NEWER" }, { text: "OLDER" }]);
	});

	it("preserves the published order for entries that share a version (stable sort)", () => {
		// Two entries in the same release — author chose order in
		// published.json. Descending semver sort shouldn't shuffle them.
		const sameVersionCatalog: readonly ReleaseAnnouncementCatalogEntry[] = [
			{ id: "first", items: [{ text: "FIRST" }] },
			{ id: "second", items: [{ text: "SECOND" }] },
		];
		const sameVersionPublished: readonly PublishedReleaseAnnouncement[] = [
			{ id: "first", releaseVersion: "0.21.0" },
			{ id: "second", releaseVersion: "0.21.0" },
		];
		const result = selectReleaseAnnouncement({
			catalog: sameVersionCatalog,
			published: sameVersionPublished,
			currentVersion: "0.21.0",
			lastSeenVersion: "0.19.1",
			isFirstHelmorBoot: false,
			dismissedIds: new Set(),
		});
		expect(result?.ids).toEqual(["first", "second"]);
	});

	it("returns null when there is no published entry in the upgrade range", () => {
		expect(
			selectReleaseAnnouncement({
				catalog,
				published,
				currentVersion: "0.21.0",
				lastSeenVersion: "0.20.0", // (0.20.0, 0.21.0] — nothing published here
				isFirstHelmorBoot: false,
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when the matched id has no corresponding catalog entry", () => {
		// Orphan binding — published references an id that catalog has
		// since removed. Skipped, not thrown.
		expect(
			selectReleaseAnnouncement({
				catalog: [],
				published,
				currentVersion: "0.20.0",
				lastSeenVersion: "0.19.1",
				isFirstHelmorBoot: false,
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
				isFirstHelmorBoot: false,
				dismissedIds: new Set(),
			}),
		).toBeNull();
	});
});
