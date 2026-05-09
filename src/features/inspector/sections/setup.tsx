import { useQueryClient } from "@tanstack/react-query";
import { Play, RotateCcw, Settings2, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { TABS_EASING, TABS_HOVER_TRANSITION_MS, useTabsZoom } from "../layout";
import {
	attach,
	detach,
	getScriptState,
	resizeScript,
	type ScriptStatus,
	startScript,
	stopScript,
	TRUNCATION_NOTICE,
	writeStdin,
} from "../script-store";

type SetupTabProps = {
	repoId: string | null;
	workspaceId: string | null;
	setupScript: string | null;
	isActive: boolean;
	onOpenSettings: () => void;
};

export function SetupTab({
	repoId,
	workspaceId,
	setupScript,
	isActive,
	onOpenSettings,
}: SetupTabProps) {
	const termRef = useRef<TerminalHandle | null>(null);
	const [status, setStatus] = useState<ScriptStatus>("idle");
	const [hasRun, setHasRun] = useState(false);
	const queryClient = useQueryClient();
	const { isZoomPresented, isHoverExpanded } = useTabsZoom();

	const hasScript = !!setupScript?.trim();

	useEffect(() => {
		if (!workspaceId) return;

		// Only true when attach() ran before any entry existed — i.e. the
		// auto-run case. Flipped off after the first lazy-mount replay (or
		// when attach finds an existing entry) so subsequent status changes
		// don't re-clear and re-write the whole buffer.
		let needsLazyMount = true;

		const existing = attach(workspaceId, "setup", {
			onChunk: (data) => termRef.current?.write(data),
			onStatusChange: (s) => {
				setStatus(s);
				if (s !== "idle" && needsLazyMount) {
					needsLazyMount = false;
					setHasRun(true);
					// Replay chunks buffered before TerminalOutput mounted.
					requestAnimationFrame(() => {
						const entry = getScriptState(workspaceId, "setup");
						const t = termRef.current;
						if (!entry || !t) return;
						t.clear();
						if (entry.truncated) t.write(TRUNCATION_NOTICE);
						for (const chunk of entry.chunks) t.write(chunk);
					});
				}
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
			needsLazyMount = false;
			setHasRun(true);
			setStatus(existing.status);
			const replay = () => {
				const t = termRef.current;
				if (!t) return;
				t.clear();
				if (existing.truncated) t.write(TRUNCATION_NOTICE);
				for (const chunk of existing.chunks) t.write(chunk);
			};
			// Terminal already mounted → replay now; otherwise wait one frame
			// for React to flush setHasRun(true) and mount the terminal.
			if (termRef.current) replay();
			else requestAnimationFrame(replay);
		} else {
			setHasRun(false);
			setStatus("idle");
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

	const handleData = useCallback(
		(data: string) => {
			if (!repoId || !workspaceId) return;
			writeStdin(repoId, "setup", workspaceId, data);
		},
		[repoId, workspaceId],
	);

	const handleResize = useCallback(
		(cols: number, rows: number) => {
			if (!repoId || !workspaceId) return;
			resizeScript(repoId, "setup", workspaceId, cols, rows);
		},
		[repoId, workspaceId],
	);

	return (
		<div
			id="inspector-panel-setup"
			role="tabpanel"
			aria-labelledby="inspector-tab-setup"
			hidden={!isActive}
			className={cn(
				"relative flex min-h-0 flex-1 flex-col",
				!isActive && "pointer-events-none absolute inset-0 invisible opacity-0",
			)}
		>
			{hasRun ? (
				<>
					<div className="min-h-0 flex-1">
						<TerminalOutput
							terminalRef={termRef}
							className="h-full"
							onData={handleData}
							onResize={handleResize}
						/>
					</div>

					{isZoomPresented && (status === "running" || status === "exited") && (
						<div
							className="absolute bottom-3 right-4"
							style={{
								opacity: isHoverExpanded ? 1 : 0,
								pointerEvents: isHoverExpanded ? "auto" : "none",
								transition: `opacity ${TABS_HOVER_TRANSITION_MS}ms ${TABS_EASING}`,
							}}
						>
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
		</div>
	);
}
