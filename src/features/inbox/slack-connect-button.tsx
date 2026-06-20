import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { SlackBrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import {
	type SlackImportResult,
	type SlackWorkspace,
	slackImportFromDesktop,
} from "@/lib/api";
import { I18nText } from "@/lib/i18n";
import { isMac } from "@/lib/platform";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";

/** Stable identifier for the desktop-import mutation. `SlackInboxSection`
 *  reads it via `useIsMutating` to keep its state machine in the
 *  "loading" branch while an import is in flight — otherwise a stale
 *  `inbox.error` from before re-import would win and the user would
 *  see "Couldn't load · workspace not connected" right after clicking
 *  Import. */
export const SLACK_IMPORT_MUTATION_KEY = ["slack", "import"] as const;

/** Empty-state CTA shown when the user has zero connected Slack
 *  workspaces. Reads the user's already-signed-in Slack desktop session
 *  — passkeys, SSO, admin 2FA are all already done by the desktop app,
 *  so we don't have to deal with them.
 *
 *  `className` lets a different surface (e.g. the Settings → Context
 *  panel) override the default viewport-height container. The inbox
 *  uses the full sidebar height; settings uses a smaller fixed slot. */
export function SlackConnectState({
	onConnected,
	className = "min-h-[calc(100vh-200px)]",
}: {
	onConnected?: (teamId: string) => void;
	className?: string;
}) {
	const importMutation = useSlackImportMutation({
		onImported: (workspace) => onConnected?.(workspace.teamId),
	});
	const desktopImportSupported = isMac();

	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center gap-4 px-6 text-center",
				className,
			)}
		>
			<SlackBrandIcon className="text-muted-foreground/80" size={28} />
			<div className="space-y-1">
				<div className="text-ui font-medium text-foreground">
					<I18nText source={"Connect a Slack workspace"} />
				</div>
				<div className="text-pretty text-small leading-5 text-muted-foreground">
					{desktopImportSupported ? (
						<I18nText
							source={
								"Connects to your signed-in Slack desktop app. Everything stays local and secure on your device."
							}
						/>
					) : (
						<I18nText
							source={
								"Slack desktop import is available on macOS. Windows support is not wired up yet."
							}
						/>
					)}
				</div>
			</div>
			<Button
				type="button"
				variant="default"
				size="sm"
				className="cursor-interactive text-small"
				onClick={() => importMutation.mutate()}
				disabled={!desktopImportSupported || importMutation.isPending}
			>
				{importMutation.isPending ? (
					<>
						<Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
						Reading session…
					</>
				) : (
					"Connect Slack"
				)}
			</Button>
		</div>
	);
}

/** Render the result of a desktop-import attempt as a workspace toast. */
function handleImportResult(
	result: SlackImportResult,
	pushToast: ReturnType<typeof useWorkspaceToast>,
) {
	const importedCount = result.imported.length;
	const alreadyCount = result.alreadyConnected.length;
	const failedCount = result.failed.length;

	// Branch on outcome: "nothing happened" is a neutral default toast,
	// any failed slot makes the whole batch destructive (we want the user
	// to see the red affordance even if some succeeded), and a clean run
	// must opt into the default variant explicitly — `pushWorkspaceToast`
	// defaults to destructive when no variant is passed (it's the
	// app-wide "action failed" channel), so leaving it `undefined` would
	// render success in red.
	if (importedCount === 0 && alreadyCount === 0 && failedCount === 0) {
		pushToast(
			"No signed-in Slack workspaces were found in your desktop app.",
			"Nothing to connect",
			"default",
		);
		return;
	}

	const parts: string[] = [];
	if (importedCount > 0)
		parts.push(
			`Connected ${importedCount} workspace${importedCount === 1 ? "" : "s"}`,
		);
	if (alreadyCount > 0) parts.push(`${alreadyCount} already connected`);
	const message =
		failedCount > 0
			? `${parts.join(", ")}. ${failedCount} failed: ${result.failed
					.map((f) => `${f.teamName} (${f.reason})`)
					.join("; ")}`
			: `${parts.join(", ")}.`;

	pushToast(
		message,
		failedCount > 0 ? "Slack connect: partial" : "Slack connect",
		failedCount > 0 ? "destructive" : "default",
	);
}

/** Mutation factory the workspace switcher reuses to surface "Import
 *  from Slack desktop" as a one-click action when ≥1 workspace already
 *  exists.
 *
 *  Side effects on success:
 *  - Bumps the workspace + inbox + emoji caches for every team the
 *    backend just imported or re-attached credentials for. Without
 *    this, a re-import after a credential rotation leaves
 *    `useSlackInboxItems` stuck on its previous `"workspace … is not
 *    connected"` error, even though the import just fixed the
 *    underlying keychain entry. (The `SlackWorkspacesChanged`
 *    UI-mutation event covers the workspace list itself, but it
 *    doesn't reach per-team inbox / emoji queries — that's what we
 *    explicitly invalidate here.)
 *  - The mutation is tagged with `SLACK_IMPORT_MUTATION_KEY` so the
 *    inbox section can read the in-flight state via `useIsMutating`
 *    and stay in the loading branch instead of showing a stale error
 *    while the import runs. */
export function useSlackImportMutation(opts?: {
	onImported?: (workspace: SlackWorkspace) => void;
}) {
	const pushToast = useWorkspaceToast();
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: SLACK_IMPORT_MUTATION_KEY,
		mutationFn: slackImportFromDesktop,
		onSuccess: (result) => {
			handleImportResult(result, pushToast);
			const teamsToRefresh = new Set<string>();
			for (const w of result.imported) teamsToRefresh.add(w.teamId);
			for (const w of result.alreadyConnected) teamsToRefresh.add(w.teamId);
			for (const teamId of teamsToRefresh) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.slackInbox(teamId),
				});
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.slackEmojiMap(teamId),
				});
			}
			// `SlackWorkspacesChanged` already invalidates `slackWorkspaces`
			// through the UI-sync bridge, but a defensive nudge here makes
			// the success path self-contained regardless of event-bridge
			// timing.
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.slackWorkspaces,
			});
			const first = result.imported[0] ?? result.alreadyConnected[0];
			if (first) opts?.onImported?.(first);
		},
		onError: (error) => {
			const message =
				error instanceof Error
					? error.message
					: "Couldn't read Slack desktop session.";
			pushToast(message, "Connect failed", "destructive");
		},
	});
}
