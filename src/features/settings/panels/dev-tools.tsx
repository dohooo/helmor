import { Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { devResetAllData, loadDataInfo } from "@/lib/api";

export function DevToolsPanel() {
	const [dataDir, setDataDir] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void loadDataInfo().then((info) => {
			if (info) setDataDir(info.dataRoot);
		});
	}, []);

	const handleReset = useCallback(async () => {
		setResetting(true);
		setError(null);
		try {
			await devResetAllData();
			// Full page reload to reset all component state (selected
			// workspace/session, settings context, etc.) — query invalidation
			// alone leaves stale useState references.
			window.location.reload();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setResetting(false);
			setConfirmOpen(false);
		}
	}, []);

	return (
		<div className="flex flex-col gap-3">
			{/* Reset All Data */}
			<div className="rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
				<div className="flex items-center gap-2 text-[13px] font-medium leading-snug text-foreground">
					<Trash2 className="size-3.5 text-destructive" strokeWidth={1.8} />
					Reset All Data
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Delete all workspaces, sessions, messages, and repositories from the
					development database. Filesystem artefacts (worktrees,
					archived-contexts, paste-cache) will also be removed.
				</div>
				{dataDir && (
					<div className="mt-2 text-[11px] text-muted-foreground/70">
						Data directory:{" "}
						<code className="rounded bg-muted px-1 py-0.5">{dataDir}</code>
					</div>
				)}

				<Button
					variant="destructive"
					size="sm"
					className="mt-3"
					onClick={() => {
						setError(null);
						setConfirmOpen(true);
					}}
					disabled={resetting}
				>
					{resetting ? (
						<>
							<Loader2 className="mr-1.5 size-3.5 animate-spin" />
							Resetting...
						</>
					) : (
						"Reset All Dev Data"
					)}
				</Button>

				{error && (
					<div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
						{error}
					</div>
				)}
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Confirm Reset"
				description={
					<>
						This will permanently delete{" "}
						<strong>all workspaces, sessions, and repositories</strong> from the
						development database. This action cannot be undone. You can
						re-import from Conductor afterwards.
					</>
				}
				confirmLabel={resetting ? "Resetting..." : "Delete Everything"}
				onConfirm={() => void handleReset()}
				loading={resetting}
			/>
		</div>
	);
}
