import {
	ChevronDownIcon,
	ChevronUpIcon,
	ExternalLinkIcon,
	PanelRightOpenIcon,
	SettingsIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GithubBrandIcon } from "@/components/brand-icon";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { Button } from "@/components/ui/button";
import {
	GITHUB_RELEASES_URL,
	type ReleaseAnnouncement,
	type ReleaseAnnouncementAction,
	type ReleaseAnnouncementCatalogEntry,
	type ReleaseAnnouncementItem,
	selectReleaseAnnouncement,
} from "@/features/announcements/announcements";
import releaseAnnouncementCatalog from "@/features/announcements/release-announcement-catalog.json";
import {
	dismissReleaseAnnouncement,
	isFirstHelmorBoot,
	readLastDismissedReleaseVersion,
	readLastSeenInstallVersion,
	writeLastSeenInstallVersion,
} from "@/features/announcements/storage";
import type { SettingsSection } from "@/features/settings";
import type { WorkspaceRightSidebarMode } from "@/lib/settings";
import packageJson from "../../../package.json";

const APP_VERSION = packageJson.version;
const RELEASE_ANNOUNCEMENT_CATALOG =
	releaseAnnouncementCatalog.items as readonly ReleaseAnnouncementCatalogEntry[];

type ReleaseAnnouncementToastHostProps = {
	onOpenChangelog: () => void;
	onOpenSettings: (section?: SettingsSection) => void;
	onSetRightSidebarMode: (mode: WorkspaceRightSidebarMode) => void;
};

export function ReleaseAnnouncementToastHost({
	onOpenChangelog,
	onOpenSettings,
	onSetRightSidebarMode,
}: ReleaseAnnouncementToastHostProps) {
	const shownVersionsRef = useRef<string | null>(null);
	const [announcement, setAnnouncement] = useState<ReleaseAnnouncement | null>(
		null,
	);

	useEffect(() => {
		const nextAnnouncement = selectReleaseAnnouncement({
			catalog: RELEASE_ANNOUNCEMENT_CATALOG,
			currentVersion: APP_VERSION,
			lastSeenVersion: readLastSeenInstallVersion(),
			// Distinguish "never used Helmor" (suppress) from "existing
			// user picking up the announcement system for the first time"
			// (replay backlog). Without this check, every existing user's
			// upgrade to the launch version of this feature gets silently
			// classified as a fresh install — meaning the very toast that
			// introduces the announcement system is never seen by anyone.
			isFirstHelmorBoot: isFirstHelmorBoot(),
			lastDismissedReleaseVersion: readLastDismissedReleaseVersion(),
		});
		// Always advance: bootstraps first-install (so we never re-evaluate
		// fresh installs as upgrades) and prevents re-showing the same
		// version's toast on the next mount.
		writeLastSeenInstallVersion(APP_VERSION);
		if (!nextAnnouncement) return;

		// Same set of versions already shown this mount — React strict mode can
		// fire this effect twice in dev; the join key dedupes.
		const versionsKey = nextAnnouncement.releaseVersions.join(",");
		if (shownVersionsRef.current === versionsKey) return;
		shownVersionsRef.current = versionsKey;
		setAnnouncement(nextAnnouncement);
	}, []);

	if (!announcement) return null;

	const runAction = (action: ReleaseAnnouncementAction) => {
		switch (action.type) {
			case "setRightSidebarMode":
				onSetRightSidebarMode(action.mode);
				break;
			case "openSettings":
				onOpenSettings(action.section);
				break;
		}
	};

	const close = () => {
		// releaseVersions is sorted newest-first; the watermark stored by
		// dismissReleaseAnnouncement collapses older versions too, so one
		// call covers a skipped-version backlog.
		const newest = announcement.releaseVersions[0];
		if (newest) dismissReleaseAnnouncement(newest);
		setAnnouncement(null);
	};

	return (
		<div className="fixed right-4 bottom-4 z-50 max-w-[calc(100vw-32px)]">
			<ReleaseAnnouncementToast
				announcement={announcement}
				onClose={close}
				onOpenChangelog={onOpenChangelog}
				onRunAction={runAction}
			/>
		</div>
	);
}

function ReleaseAnnouncementToast({
	announcement,
	onClose,
	onOpenChangelog,
	onRunAction,
}: {
	announcement: ReleaseAnnouncement;
	onClose: () => void;
	onOpenChangelog: () => void;
	onRunAction: (action: ReleaseAnnouncementAction) => void;
}) {
	const [collapsed, setCollapsed] = useState(false);

	return (
		<div className="w-[410px] max-w-[calc(100vw-32px)] rounded-lg border border-border/70 bg-popover p-3.5 text-popover-foreground shadow-2xl">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<HelmorLogoAnimated
						size={18}
						autoplay={false}
						className="shrink-0 opacity-90"
					/>
					<div className="truncate text-[13px] font-semibold leading-none text-foreground">
						New in v{announcement.version}
					</div>
				</div>
				<div className="-mr-1 flex items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="text-muted-foreground hover:text-foreground"
						aria-label={
							collapsed
								? "Expand release announcement"
								: "Collapse release announcement"
						}
						onClick={() => setCollapsed((value) => !value)}
					>
						{collapsed ? (
							<ChevronUpIcon className="size-3.5" />
						) : (
							<ChevronDownIcon className="size-3.5" />
						)}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="text-muted-foreground hover:text-foreground"
						aria-label="Dismiss release announcement"
						onClick={onClose}
					>
						<XIcon className="size-3.5" />
					</Button>
				</div>
			</div>
			{collapsed ? null : (
				<>
					{/* Cap height so a skipped-version backlog (many items)
					 *  scrolls inside the card instead of pushing the card
					 *  off the top of the screen. 50vh leaves room for header
					 *  + footer + macOS chrome on small displays. */}
					<ul className="mt-3 max-h-[50vh] space-y-2 overflow-y-auto pl-[6px] [scrollbar-width:thin]">
						{announcement.items.map((item, index) => (
							// Prefix with index so a skipped-version backlog
							// that happens to merge two items with identical
							// text doesn't collide. Index is stable here —
							// the list is built once per mount and never
							// reordered.
							<ReleaseAnnouncementListItem
								key={`${index}::${item.text}`}
								item={item}
								onRunAction={onRunAction}
							/>
						))}
					</ul>
					<div className="-mx-3.5 -mb-3.5 mt-3 border-t border-border/60 px-3.5 py-1.5">
						<div className="flex items-center justify-end gap-3">
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7"
								onClick={onOpenChangelog}
							>
								<GithubBrandIcon size={14} />
								Changelogs
								<ExternalLinkIcon className="size-3" />
							</Button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}

function ReleaseAnnouncementListItem({
	item,
	onRunAction,
}: {
	item: ReleaseAnnouncementItem;
	onRunAction: (action: ReleaseAnnouncementAction) => void;
}) {
	const action = item.action;

	return (
		<li className="grid grid-cols-[18px_1fr] gap-[2px] text-[12px] leading-relaxed text-muted-foreground">
			<span
				className="leading-relaxed text-muted-foreground/70"
				aria-hidden="true"
			>
				-
			</span>
			<div className="min-w-0">
				<span>{item.text}</span>
				{action ? (
					<button
						type="button"
						className="ml-1.5 inline cursor-interactive align-baseline text-[12px] leading-[inherit] font-semibold text-foreground hover:underline"
						onClick={() => onRunAction(action.value)}
					>
						<ActionIcon
							action={action.value}
							className="mr-1 inline-block size-[1em] align-[-0.125em]"
						/>
						{action.label}
					</button>
				) : null}
			</div>
		</li>
	);
}

function ActionIcon({
	action,
	className = "size-3.5",
}: {
	action: ReleaseAnnouncementAction;
	className?: string;
}) {
	switch (action.type) {
		case "setRightSidebarMode":
			return <PanelRightOpenIcon className={className} />;
		case "openSettings":
			return <SettingsIcon className={className} />;
	}
}

export { GITHUB_RELEASES_URL };
