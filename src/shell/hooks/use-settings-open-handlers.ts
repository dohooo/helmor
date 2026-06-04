import { useCallback } from "react";
import type { SettingsSection } from "@/features/settings";

type OpenSettingsFn = (
	workspaceId: string | null,
	workspaceRepoId: string | null,
	initialSection?: SettingsSection,
) => void;

/**
 * The two "open settings" handlers AppShell hands to the announcement toast
 * host and the various settings entry points. Extracted verbatim from AppShell
 * (Phase 1 split); `repoId` (formerly read inline off the workspace-detail
 * query) is passed in so the hook stays decoupled from AppShell's query wiring.
 */
export function useSettingsOpenHandlers({
	selectedWorkspaceId,
	repoId,
	onOpenSettings,
}: {
	selectedWorkspaceId: string | null;
	repoId: string | null;
	onOpenSettings: OpenSettingsFn;
}) {
	// Optional `initialSection` lets callers jump straight to a panel
	// (e.g. inspector's "Add run script" → the current repo's Scripts
	// editor). Bound directly to button onClick is still safe — React
	// passes the click event as the first arg, which doesn't match the
	// `SettingsSection` shape, so we coerce non-string args back to
	// `undefined` to preserve the original zero-arg behavior.
	const handleOpenSettings = useCallback(
		(initialSection?: SettingsSection): void => {
			const section =
				typeof initialSection === "string" ? initialSection : undefined;
			onOpenSettings(selectedWorkspaceId, repoId, section);
		},
		[onOpenSettings, repoId, selectedWorkspaceId],
	);
	const handleOpenAnnouncementSettings = useCallback(
		(initialSection?: SettingsSection): void => {
			// Sentinel: announcements written before a workspace is
			// selected can ask for "the current repo's Scripts section"
			// without knowing the repo id at authoring time. We resolve
			// it here and replay the same open-then-scroll dance the
			// inspector empty states use.
			if (initialSection === ("repo:current" as SettingsSection)) {
				if (repoId) {
					onOpenSettings(null, null, `repo:${repoId}`);
					requestAnimationFrame(() => {
						window.dispatchEvent(
							new CustomEvent("helmor:scroll-to-repo-scripts"),
						);
					});
					return;
				}
				// No active repo (chat-only workspace, or none selected) —
				// fall back to plain settings rather than a broken link.
				onOpenSettings(null, null);
				return;
			}
			onOpenSettings(null, null, initialSection);
		},
		[onOpenSettings, repoId],
	);
	return { handleOpenSettings, handleOpenAnnouncementSettings };
}
