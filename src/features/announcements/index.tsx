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
	type ReleaseAnnouncementItem,
	selectReleaseAnnouncement,
} from "@/features/announcements/announcements";
import publishedReleaseAnnouncements from "@/features/announcements/published-release-announcements.json";
import { RELEASE_ANNOUNCEMENT_CATALOG } from "@/features/announcements/release-announcement-catalog";
import {
	dismissReleaseAnnouncement,
	readDismissedReleaseAnnouncementIds,
	readLastSeenInstallVersion,
	writeLastSeenInstallVersion,
} from "@/features/announcements/storage";
import type { SettingsSection } from "@/features/settings";
import type { WorkspaceRightSidebarMode } from "@/lib/settings";
import packageJson from "../../../package.json";

const APP_VERSION = packageJson.version;

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
	const shownIdRef = useRef<string | null>(null);
	const [announcement, setAnnouncement] = useState<ReleaseAnnouncement | null>(
		null,
	);

	useEffect(() => {
		const nextAnnouncement = selectReleaseAnnouncement({
			catalog: RELEASE_ANNOUNCEMENT_CATALOG,
			published: publishedReleaseAnnouncements.items,
			currentVersion: APP_VERSION,
			lastSeenVersion: readLastSeenInstallVersion(),
			dismissedIds: readDismissedReleaseAnnouncementIds(),
		});
		// Always advance: bootstraps first-install (so we never re-evaluate
		// fresh installs as upgrades) and prevents re-showing the same
		// version's toast on the next mount.
		writeLastSeenInstallVersion(APP_VERSION);
		if (!nextAnnouncement || shownIdRef.current === nextAnnouncement.id) return;

		shownIdRef.current = nextAnnouncement.id;
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
		dismissReleaseAnnouncement(announcement.id);
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
					<ul className="mt-3 space-y-2 pl-[6px]">
						{announcement.items.map((item) => (
							<ReleaseAnnouncementListItem
								key={item.text}
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
						className="ml-1.5 inline cursor-pointer align-baseline text-[12px] leading-[inherit] font-semibold text-foreground hover:underline"
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
