import { Play, RotateCcw, Settings2, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import {
	attach,
	detach,
	type ScriptStatus,
	startScript,
	stopScript,
} from "../script-store";

type RunTabProps = {
	repoId: string | null;
	workspaceId: string | null;
	runScript: string | null;
	isActive: boolean;
	pendingRun?: boolean;
	onPendingRunHandled?: () => void;
	onOpenSettings: () => void;
};

export function RunTab({
	repoId,
	workspaceId,
	runScript,
	isActive,
	pendingRun,
	onPendingRunHandled,
	onOpenSettings,
}: RunTabProps) {
	const termRef = useRef<TerminalHandle | null>(null);
	const [status, setStatus] = useState<ScriptStatus>("idle");
	const [hasRun, setHasRun] = useState(false);

	useEffect(() => {
		if (!workspaceId) return;

		const existing = attach(workspaceId, "run", {
			onChunk: (data) => termRef.current?.write(data),
			onStatusChange: setStatus,
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
			if (termRef.current) replay();
			else requestAnimationFrame(replay);
		} else {
			setHasRun(false);
			setStatus("idle");
			termRef.current?.clear();
		}

		return () => detach(workspaceId, "run");
	}, [workspaceId]);

	const handleRun = useCallback(() => {
		if (!repoId || !workspaceId) return;
		termRef.current?.clear();
		setStatus("running");
		setHasRun(true);
		startScript(repoId, "run", workspaceId);
	}, [repoId, workspaceId]);

	const handleStop = useCallback(() => {
		if (!repoId || !workspaceId) return;
		stopScript(repoId, "run", workspaceId);
	}, [repoId, workspaceId]);

	// Handle pending run request from Cmd+R shortcut.
	useEffect(() => {
		if (pendingRun && isActive && repoId && runScript?.trim()) {
			onPendingRunHandled?.();
			handleRun();
		}
	}, [pendingRun, isActive, repoId, runScript, handleRun, onPendingRunHandled]);

	const hasScript = !!runScript?.trim();

	return (
		<TabsContent
			value="run"
			forceMount
			className="relative flex min-h-0 flex-1 flex-col data-[state=inactive]:invisible data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:pointer-events-none"
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
								{status === "running" ? "Stop" : "Rerun"}
							</Button>
						</div>
					)}
				</>
			) : !hasScript ? (
				<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
					<Button
						variant="outline"
						size="sm"
						className="gap-1.5 text-[12px]"
						onClick={onOpenSettings}
					>
						<Settings2 className="size-3.5" strokeWidth={1.8} />
						Add run script
					</Button>
					<p className="text-[12px] text-muted-foreground/70">
						Run tests or a development server to test changes in this workspace.
					</p>
				</div>
			) : (
				<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
					<p className="text-[13px] text-muted-foreground">
						No run script output
					</p>
					<p className="text-[12px] text-muted-foreground/70">
						Run script output will appear here after running.
					</p>
					<Button
						variant="outline"
						size="sm"
						className="mt-1 gap-1.5 text-[12px]"
						onClick={handleRun}
					>
						<Play className="size-3" strokeWidth={2} />
						Run
					</Button>
				</div>
			)}
		</TabsContent>
	);
}
