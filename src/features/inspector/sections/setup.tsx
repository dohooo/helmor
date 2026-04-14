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

	useEffect(() => {
		if (!workspaceId) return;

		const existing = attach(workspaceId, "setup", {
			onChunk: (data) => termRef.current?.write(data),
			onStatusChange: (s) => {
				setStatus(s);
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
			const replay = () => {
				const t = termRef.current;
				if (!t) return;
				t.clear();
				for (const chunk of existing.chunks) t.write(chunk);
			};
			// Terminal already mounted → replay now; otherwise wait one frame
			// for React to flush setHasRun(true) and mount the terminal.
			if (termRef.current) replay();
			else requestAnimationFrame(replay);
		} else {
			setHasRun(false);
			setStatus("idle");
			hasAutoRunRef.current = false;
			termRef.current?.clear();
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

	return (
		<TabsContent
			value="setup"
			forceMount
			className="relative flex min-h-0 flex-1 flex-col data-[state=inactive]:invisible data-[state=inactive]:opacity-0 data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:pointer-events-none"
		>
			{hasRun ? (
				<>
					<div className="min-h-0 flex-1">
						<TerminalOutput terminalRef={termRef} className="h-full" />
					</div>

					{(status === "running" || status === "exited") && (
						<div className="absolute bottom-3 right-4">
							<Button
								variant={status === "running" ? "destructive" : "secondary"}
								size="sm"
								className="text-[12px] shadow-sm backdrop-blur-sm transition-none"
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
				</>
			) : !hasScript ? (
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
			) : (
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
			)}
		</TabsContent>
	);
}
