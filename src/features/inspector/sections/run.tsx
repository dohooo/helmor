import { Play, RotateCcw, Settings2, Square } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { executeRepoScript, stopRepoScript } from "@/lib/api";

type ScriptStatus = "idle" | "running" | "exited";

type RunTabProps = {
	repoId: string | null;
	workspaceId: string | null;
	runScript: string | null;
	onOpenSettings: () => void;
};

export function RunTab({
	repoId,
	workspaceId,
	runScript,
	onOpenSettings,
}: RunTabProps) {
	const termRef = useRef<TerminalHandle | null>(null);
	const [status, setStatus] = useState<ScriptStatus>("idle");
	const [hasRun, setHasRun] = useState(false);

	const handleRun = useCallback(() => {
		if (!repoId) return;
		termRef.current?.clear();
		setStatus("running");
		setHasRun(true);
		executeRepoScript(
			repoId,
			"run",
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
	}, [repoId, workspaceId]);

	const handleStop = useCallback(() => {
		if (!repoId) return;
		void stopRepoScript(repoId, "run", workspaceId);
	}, [repoId, workspaceId]);

	const hasScript = !!runScript?.trim();

	// Empty state: no script configured
	if (!hasScript && !hasRun) {
		return (
			<TabsContent value="run" className="flex-1 min-h-0">
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
			</TabsContent>
		);
	}

	// Ready state before first run
	if (!hasRun) {
		return (
			<TabsContent value="run" className="flex-1 min-h-0">
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
			</TabsContent>
		);
	}

	return (
		<TabsContent value="run" className="relative flex min-h-0 flex-1 flex-col">
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
						Rerun
					</Button>
				) : null}
			</div>
		</TabsContent>
	);
}
