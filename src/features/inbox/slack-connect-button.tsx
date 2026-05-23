import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { SlackBrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import {
	type SlackImportResult,
	type SlackWorkspace,
	slackImportFromDesktop,
} from "@/lib/api";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";

/** Empty-state CTA shown when the user has zero connected Slack
 *  workspaces. Reads the user's already-signed-in Slack desktop session
 *  — passkeys, SSO, admin 2FA are all already done by the desktop app,
 *  so we don't have to deal with them. */
export function SlackConnectState({
	onConnected,
}: {
	onConnected?: (teamId: string) => void;
}) {
	const pushToast = useWorkspaceToast();

	const importMutation = useMutation({
		mutationFn: slackImportFromDesktop,
		onSuccess: (result) => {
			handleImportResult(result, pushToast);
			const first = result.imported[0] ?? result.alreadyConnected[0];
			if (first) onConnected?.(first.teamId);
		},
		onError: (error) => {
			const message =
				error instanceof Error
					? error.message
					: "Couldn't read Slack desktop session.";
			pushToast(message, "Import failed", "destructive");
		},
	});

	return (
		<div className="flex min-h-[calc(100vh-200px)] flex-col items-center justify-center gap-4 px-6 text-center">
			<SlackBrandIcon className="text-muted-foreground/80" size={28} />
			<div className="space-y-1">
				<div className="text-ui font-medium text-foreground">
					Connect a Slack workspace
				</div>
				<div className="text-pretty text-small leading-5 text-muted-foreground">
					Import directly from your signed-in Slack desktop app — no extra
					login, all your workspaces at once.
				</div>
			</div>
			<Button
				type="button"
				variant="default"
				size="sm"
				className="cursor-interactive text-small"
				onClick={() => importMutation.mutate()}
				disabled={importMutation.isPending}
			>
				{importMutation.isPending ? (
					<>
						<Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
						Reading session…
					</>
				) : (
					"Import from Slack desktop"
				)}
			</Button>
			<p className="max-w-[280px] text-balance text-mini leading-4 text-muted-foreground/70">
				Helmor reads as you, using the same session your Slack desktop app
				already has. Depending on workspace security policy, admins may be
				notified.
			</p>
		</div>
	);
}

/** Render the result of a desktop-import attempt as a workspace toast.
 *  Split out so the workspace switcher can reuse the same UX. */
export function handleImportResult(
	result: SlackImportResult,
	pushToast: ReturnType<typeof useWorkspaceToast>,
) {
	const importedCount = result.imported.length;
	const alreadyCount = result.alreadyConnected.length;
	const failedCount = result.failed.length;

	if (importedCount === 0 && alreadyCount === 0 && failedCount === 0) {
		pushToast(
			"No signed-in Slack workspaces were found in your desktop app.",
			"Nothing to import",
		);
		return;
	}

	const parts: string[] = [];
	if (importedCount > 0)
		parts.push(
			`Imported ${importedCount} workspace${importedCount === 1 ? "" : "s"}`,
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
		failedCount > 0 ? "Slack import: partial" : "Slack import",
		failedCount > 0 ? "destructive" : undefined,
	);
}

/** Mutation factory the workspace switcher reuses to surface "Import
 *  from Slack desktop" as a one-click action when ≥1 workspace already
 *  exists. */
export function useSlackImportMutation(opts?: {
	onImported?: (workspace: SlackWorkspace) => void;
}) {
	const pushToast = useWorkspaceToast();
	return useMutation({
		mutationFn: slackImportFromDesktop,
		onSuccess: (result) => {
			handleImportResult(result, pushToast);
			const first = result.imported[0] ?? result.alreadyConnected[0];
			if (first) opts?.onImported?.(first);
		},
		onError: (error) => {
			const message =
				error instanceof Error
					? error.message
					: "Couldn't read Slack desktop session.";
			pushToast(message, "Import failed", "destructive");
		},
	});
}
