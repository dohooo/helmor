export const DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY =
	"helmor:dismissed-release-announcements";

export const LAST_SEEN_INSTALL_VERSION_STORAGE_KEY =
	"helmor:last-seen-install-version";

export function readDismissedReleaseAnnouncementIds(): Set<string> {
	try {
		const raw = window.localStorage.getItem(
			DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
		);
		if (!raw) return new Set();

		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();

		return new Set(parsed.filter((id): id is string => typeof id === "string"));
	} catch {
		return new Set();
	}
}

export function dismissReleaseAnnouncement(id: string): void {
	const dismissed = readDismissedReleaseAnnouncementIds();
	dismissed.add(id);
	try {
		window.localStorage.setItem(
			DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY,
			JSON.stringify([...dismissed]),
		);
	} catch (error) {
		console.error(
			"[helmor] failed to save release announcement dismissal",
			error,
		);
	}
}

export function readLastSeenInstallVersion(): string | null {
	try {
		const raw = window.localStorage.getItem(
			LAST_SEEN_INSTALL_VERSION_STORAGE_KEY,
		);
		return typeof raw === "string" && raw.length > 0 ? raw : null;
	} catch {
		return null;
	}
}

export function writeLastSeenInstallVersion(version: string): void {
	try {
		window.localStorage.setItem(LAST_SEEN_INSTALL_VERSION_STORAGE_KEY, version);
	} catch (error) {
		console.error("[helmor] failed to save last seen install version", error);
	}
}
