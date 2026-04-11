import { useQueryClient } from "@tanstack/react-query";
import { Play, RotateCcw, Settings2, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import {
	completeWorkspaceSetup,
	executeRepoScript,
	stopRepoScript,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

type ScriptStatus = "idle" | "running" | "exited";

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
	const queryClient = useQueryClient();

	const hasScript = !!setupScript?.trim();

	const handleRun = useCallback(() => {
		if (!repoId) return;
		termRef.current?.clear();
		setStatus("running");
		setHasRun(true);
		executeRepoScript(
			repoId,
			"setup",
			(event) => {
				switch (event.type) {
					case "started":
						break;
					case "stdout":
					case "stderr":
						termRef.current?.write(event.data);
						break;
					case "exited":
						setStatus("exited");
						if (event.code === 0 && workspaceId) {
							queryClient.invalidateQueries({
								queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
							});
						}
						break;
					case "error":
						termRef.current?.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
						setStatus("exited");
						break;
				}
			},
			workspaceId,
		).catch((err) => {
			termRef.current?.write(`\r\n\x1b[31mFailed to start: ${err}\x1b[0m\r\n`);
			setStatus("exited");
		});
	}, [repoId, workspaceId, queryClient]);

	const handleStop = useCallback(() => {
		if (!repoId) return;
		void stopRepoScript(repoId, "setup", workspaceId);
	}, [repoId, workspaceId]);

	// Auto-run setup when workspace is pending and script is available.
	useEffect(() => {
		if (workspaceState === "setup_pending" && hasScript && status === "idle") {
			handleRun();
		}
	}, [workspaceState, hasScript, status, handleRun]);

	// Auto-complete if workspace is pending but no script is configured.
	// Wait until scriptsLoaded to distinguish "still loading" from "no script".
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
			<div className="absolute bottom-3 right-3 flex items-center gap-1.5 [will-change:transform]">
				{status === "running" ? (
					<Button
						variant="secondary"
						size="sm"
						className="text-[12px] transition-colors"
						onClick={handleStop}
					>
						<Square className="size-3" strokeWidth={2} />
						Stop
					</Button>
				) : status === "exited" ? (
					<Button
						variant="secondary"
						size="sm"
						className="text-[12px] transition-colors"
						onClick={handleRun}
						disabled={!hasScript}
					>
						<RotateCcw className="size-3" strokeWidth={2} />
						Rerun setup
					</Button>
				) : null}
			</div>
		</TabsContent>
	);
}
