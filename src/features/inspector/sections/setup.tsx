import { useQueryClient } from "@tanstack/react-query";
import { Play, RotateCcw, Settings2, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { completeWorkspaceSetup } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	attach,
	detach,
	getScriptState,
	type ScriptStatus,
	startScript,
	stopScript,
} from "../script-store";

type SetupTabProps = {
	repoId: string | null;
	workspaceId: string | null;
	workspaceState: string | null;
	setupScript: string | null;
	scriptsLoaded: boolean;
	onOpenSettings: () => void;
};

export function SetupTab({
	repoId,
	workspaceId,
	workspaceState,
	setupScript,
	scriptsLoaded,
	onOpenSettings,
}: SetupTabProps) {
	const termRef = useRef<TerminalHandle | null>(null);
	const [status, setStatus] = useState<ScriptStatus>("idle");
	const [hasRun, setHasRun] = useState(false);
	const hasAutoRunRef = useRef(false);
	const queryClient = useQueryClient();

	const hasScript = !!setupScript?.trim();

	// Attach to store on mount / when workspaceId changes; replay buffered output.
	useEffect(() => {
		if (!workspaceId) return;

		const existing = attach(workspaceId, "setup", {
			onChunk: (data) => termRef.current?.write(data),
			onStatusChange: (s) => {
				setStatus(s);
				// Invalidate workspace detail when setup completes successfully.
				if (s === "exited") {
					const state = getScriptState(workspaceId, "setup");
					if (state?.exitCode === 0) {
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						});
					}
				}
			},
		});

		if (existing) {
			setHasRun(true);
			setStatus(existing.status);
			requestAnimationFrame(() => {
				termRef.current?.clear();
				for (const chunk of existing.chunks) {
					termRef.current?.write(chunk);
				}
			});
		} else {
			setHasRun(false);
			setStatus("idle");
			// Reset auto-run guard for this new workspace.
			hasAutoRunRef.current = false;
		}

		return () => detach(workspaceId, "setup");
	}, [workspaceId, queryClient]);

	const handleRun = useCallback(() => {
		if (!repoId || !workspaceId) return;
		termRef.current?.clear();
		setStatus("running");
		setHasRun(true);
		startScript(repoId, "setup", workspaceId);
	}, [repoId, workspaceId]);

	const handleStop = useCallback(() => {
		if (!repoId || !workspaceId) return;
		stopScript(repoId, "setup", workspaceId);
	}, [repoId, workspaceId]);

	// Auto-run setup when workspace is pending and script is available.
	useEffect(() => {
		if (
			workspaceState === "setup_pending" &&
			hasScript &&
			status === "idle" &&
			!hasAutoRunRef.current
		) {
			hasAutoRunRef.current = true;
			handleRun();
		}
	}, [workspaceState, hasScript, status, handleRun]);

	// Auto-complete if workspace is pending but no script is configured.
	useEffect(() => {
		if (
			workspaceState === "setup_pending" &&
			scriptsLoaded &&
			!hasScript &&
			workspaceId
		) {
			void completeWorkspaceSetup(workspaceId).then(() => {
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				});
			});
		}
	}, [workspaceState, scriptsLoaded, hasScript, workspaceId, queryClient]);

	// Empty state: no script configured
	if (!hasScript && !hasRun) {
		return (
			<TabsContent value="setup" className="flex-1 min-h-0">
				<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
					<p className="text-[13px] font-medium text-muted-foreground">
						No setup script configured
					</p>
					<p className="text-[12px] text-muted-foreground/70">
						Add a setup script in repository settings to run it here.
					</p>
					<Button
						variant="outline"
						size="sm"
						className="mt-1 gap-1.5 text-[12px]"
						onClick={onOpenSettings}
					>
						<Settings2 className="size-3.5" strokeWidth={1.8} />
						Open settings
					</Button>
				</div>
			</TabsContent>
		);
	}

	// Ready state before first run
	if (!hasRun) {
		return (
			<TabsContent value="setup" className="flex-1 min-h-0">
				<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
					<p className="text-[13px] text-muted-foreground">
						No setup script output
					</p>
					<p className="text-[12px] text-muted-foreground/70">
						Setup script output will appear here after running setup.
					</p>
					<Button
						variant="outline"
						size="sm"
						className="mt-1 gap-1.5 text-[12px]"
						onClick={handleRun}
					>
						<Play className="size-3" strokeWidth={2} />
						Run setup
					</Button>
				</div>
			</TabsContent>
		);
	}

	return (
		<TabsContent
			value="setup"
			className="relative flex min-h-0 flex-1 flex-col"
		>
			{/* Terminal */}
			<div className="min-h-0 flex-1">
				<TerminalOutput terminalRef={termRef} className="h-full" />
			</div>

			{/* Floating action button */}
			{(status === "running" || status === "exited") && (
				<div className="absolute bottom-3 right-3">
					<Button
						variant={status === "running" ? "destructive" : "secondary"}
						size="sm"
						className="text-[12px] transition-none"
						onClick={status === "running" ? handleStop : handleRun}
						disabled={status === "exited" && !hasScript}
					>
						{status === "running" ? (
							<Square className="size-3" strokeWidth={2} />
						) : (
							<RotateCcw className="size-3" strokeWidth={2} />
						)}
						{status === "running" ? "Stop" : "Rerun setup"}
					</Button>
				</div>
			)}
		</TabsContent>
	);
}
