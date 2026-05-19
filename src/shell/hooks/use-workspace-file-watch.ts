import { useEffect } from "react";
import { startWorkspaceWatch, stopWorkspaceWatch } from "@/lib/api";

/**
 * Drive the workspace's file watcher lifecycle. Starts a watch on
 * mount (or when `workspaceId` / `workspaceDir` changes), stops it
 * on unmount. The Rust side fires `WorkspaceFilesChanged` on every
 * debounced batch; the UI sync bridge in `use-ui-sync-bridge.ts`
 * already invalidates the right React Query keys.
 *
 * `runtimeName=null` runs an in-process watcher. Anything else
 * dispatches over the remote runtime — same `workspaces.runtime_name`
 * column the inspector queries already key off.
 *
 * The hook is intentionally fire-and-forget: errors are logged to
 * the console (the operator wants to see them in dev) but never
 * thrown / surfaced as toasts. A failed watch falls back to the
 * pre-24g polling behaviour — staleness is annoying, but bubbling
 * an error through every workspace switch would be worse.
 */
export function useWorkspaceFileWatch(args: {
	workspaceId: string | null;
	workspaceDir: string | null;
	runtimeName: string | null | undefined;
}) {
	const { workspaceId, workspaceDir, runtimeName } = args;
	useEffect(() => {
		if (!workspaceId || !workspaceDir) return;
		let cancelled = false;
		let didStart = false;

		void startWorkspaceWatch({
			workspaceId,
			workspaceDir,
			runtimeName: runtimeName ?? null,
		})
			.then(() => {
				if (cancelled) {
					// Workspace already unmounted before the start
					// resolved — tear down what we just created.
					void stopWorkspaceWatch(workspaceId).catch(() => {});
					return;
				}
				didStart = true;
			})
			.catch((err) => {
				console.warn(
					`use-workspace-file-watch: start failed for ${workspaceId}`,
					err,
				);
			});

		return () => {
			cancelled = true;
			if (didStart) {
				void stopWorkspaceWatch(workspaceId).catch((err) => {
					console.warn(
						`use-workspace-file-watch: stop failed for ${workspaceId}`,
						err,
					);
				});
			}
		};
	}, [workspaceId, workspaceDir, runtimeName]);
}
