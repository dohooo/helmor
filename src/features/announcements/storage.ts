export const DISMISSED_RELEASE_ANNOUNCEMENTS_STORAGE_KEY =
	"helmor:dismissed-release-announcements";

export const LAST_SEEN_INSTALL_VERSION_STORAGE_KEY =
	"helmor:last-seen-install-version";

/**
 * Best-effort detection of "this device has never run Helmor before".
 * We can't ask `LAST_SEEN_INSTALL_VERSION_STORAGE_KEY` directly — it's a
 * brand-new key, so existing users look identical to new users from its
 * point of view. Instead we look for older Helmor keys that pre-date
 * the announcement system: `helmor-theme` is the most reliable signal
 * because it's read synchronously on every boot to avoid splash flash,
 * so any user who has opened a recent Helmor build has it set.
 *
 * Edge: a user who manually nukes localStorage will look "fresh" on
 * their next boot. Acceptable — they'd also lose dismiss state, theme,
 * etc., so missing one onboarding toast is the least of it.
 */
export function isFirstHelmorBoot(): boolean {
	try {
		return (
			window.localStorage.getItem("helmor-theme") === null &&
			window.localStorage.getItem("helmor-dark-theme") === null
		);
	} catch {
		// Storage access blocked — fail closed (assume not fresh) so we
		// at least try to show the toast instead of silently skipping.
		return false;
	}
}

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
