import {
	CircleStop,
	ExternalLink,
	Play,
	RotateCcw,
	Settings2,
	Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { getShortcut } from "@/features/shortcuts/registry";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import { I18nText, useI18n } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { extractPort } from "../detect-urls";
import { TABS_EASING, TABS_HOVER_TRANSITION_MS, useTabsZoom } from "../layout";
import {
	attach,
	cleanupScript,
	detach,
	resizeScript,
	type ScriptStatus,
	startScript,
	stopScript,
	TRUNCATION_NOTICE,
	writeStdin,
} from "../script-store";

type RunTabProps = {
	repoId: string | null;
	workspaceId: string | null;
	/**
	 * `RunAction.id` for the action whose lifecycle this panel mirrors. `null`
	 * when no action is selected yet (e.g. fresh repo with zero configured
	 * actions) — the body falls back to the "add first script" placeholder.
	 */
	activeRunActionId: string | null;
	/** Display name of the active action; surfaces in the empty-state heading
	 * so the user knows which action the Run button will trigger. */
	activeRunActionName: string | null;
	/** `RunAction.command` for the active action, or `null` when no action
	 * is selected. Used to decide which placeholder copy to render. */
	runScript: string | null;
	/** `RunAction.stopCommand` for the active action, or `null` when none
	 * is configured. When set AND the user has run this action at least
	 * once this session, a Cleanup button appears alongside Rerun so the
	 * user can tear down side effects (containers, daemons) left by an
	 * exited start before retrying. */
	stopCommand: string | null;
	/** True when at least one run action is configured. Drives whether the
	 * empty state offers "Add run script" (no actions yet) or the per-action
	 * empty state with the Run button. */
	hasAnyRunAction: boolean;
	isActive: boolean;
	/** Open the repo settings panel. */
	onOpenSettings: () => void;
	onStatusChange?: (status: ScriptStatus) => void;
	onUrlsChange?: (urls: string[]) => void;
};

/**
 * Compact outlined action button rendered in the Run tab header. Three
 * states driven by how many dev-server URLs have been detected in the
 * script's stdout so far:
 *
 *   - 0 URLs → disabled "Open"
 *   - 1 URL  → "Open:PORT", click opens the URL directly
 *   - 2+ URLs → hover reveals a list of URLs, click an entry to open it
 *
 * URL detection lives in {@link ../detect-urls} and runs chunk-by-chunk
 * in the script store.
 */
export function OpenDevServerButton({ urls }: { urls: string[] }) {
	const { t, f } = useI18n();
	const handleOpen = useCallback((url: string) => {
		void openUrl(url);
	}, []);

	// No URLs detected yet — keep the button visible but inert, so the
	// control is discoverable while the dev server is still booting.
	if (urls.length === 0) {
		return (
			<Button
				type="button"
				variant="outline"
				size="xs"
				className="text-muted-foreground hover:text-foreground"
				disabled
				aria-label="openDevServerNoUrlDetected"
			>
				<ExternalLink strokeWidth={1.8} />
				<I18nText source="open" />
			</Button>
		);
	}

	// Single URL — direct click-to-open, port inlined in the label.
	if (urls.length === 1) {
		const url = urls[0];
		const port = extractPort(url);
		return (
			<Button
				type="button"
				variant="outline"
				size="xs"
				className="text-muted-foreground hover:text-foreground"
				onClick={() => handleOpen(url)}
				aria-label={f("inspectorOpenDevServerAt", { url })}
			>
				<ExternalLink strokeWidth={1.8} />
				{port ? f("inspectorOpenPort", { port }) : t("open")}
			</Button>
		);
	}

	// Multiple URLs — hover reveals a picker. Label stays generic ("Open")
	// since port info would be ambiguous.
	return (
		<HoverCard openDelay={80} closeDelay={120}>
			<HoverCardTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="xs"
					className="text-muted-foreground hover:text-foreground"
					aria-label={f("inspectorOpenDevServerUrlsDetected", {
						count: urls.length,
					})}
				>
					<ExternalLink strokeWidth={1.8} />
					<I18nText source="open" />
				</Button>
			</HoverCardTrigger>
			<HoverCardContent side="top" align="end" className="w-auto min-w-48 p-1">
				<div role="menu" className="flex flex-col">
					{urls.map((url) => {
						const port = extractPort(url);
						return (
							<button
								key={url}
								type="button"
								role="menuitem"
								onClick={() => handleOpen(url)}
								className="flex cursor-interactive items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
							>
								<ExternalLink
									className="size-3 shrink-0 text-muted-foreground"
									strokeWidth={1.8}
								/>
								<span className="truncate">
									{port ? `localhost:${port}` : url}
								</span>
							</button>
						);
					})}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

export function RunTab({
	repoId,
	workspaceId,
	activeRunActionId,
	activeRunActionName,
	runScript,
	stopCommand,
	hasAnyRunAction,
	isActive,
	onOpenSettings,
	onStatusChange,
	onUrlsChange,
}: RunTabProps) {
	const { t, f } = useI18n();
	const termRef = useRef<TerminalHandle | null>(null);
	const [status, setStatus] = useState<ScriptStatus>("idle");
	const [stopping, setStopping] = useState(false);
	const [hasRun, setHasRun] = useState(false);
	const { isZoomPresented, isHoverExpanded } = useTabsZoom();
	const { settings } = useSettings();
	const runShortcut = getShortcut(settings.shortcuts, "script.run");

	// Notify parent whenever the run-script status transitions so the tab
	// header can conditionally show controls like the Open-dev-server button.
	useEffect(() => {
		onStatusChange?.(status);
	}, [status, onStatusChange]);

	useEffect(() => {
		if (!workspaceId || !activeRunActionId) {
			onUrlsChange?.([]);
			setHasRun(false);
			setStatus("idle");
			setStopping(false);
			termRef.current?.clear();
			return;
		}

		const existing = attach(
			workspaceId,
			"run",
			{
				onChunk: (data) => termRef.current?.write(data),
				onStatusChange: setStatus,
				onStoppingChange: setStopping,
				onUrlsChange: (urls) => onUrlsChange?.(urls),
				// When a fresh run is triggered externally (e.g. Cmd+R while
				// this tab is mounted), wipe the terminal so old output
				// doesn't bleed into the new run's stream.
				onReset: () => {
					termRef.current?.clear();
					setHasRun(true);
					setStopping(false);
				},
			},
			activeRunActionId,
		);

		if (existing) {
			setHasRun(true);
			setStatus(existing.status);
			setStopping(existing.stopping);
			// Replay URLs already detected on this entry so the parent's state
			// mirrors the store the moment the component mounts.
			onUrlsChange?.([...existing.urls]);
			const replay = () => {
				const t = termRef.current;
				if (!t) return;
				t.clear();
				if (existing.truncated) t.write(TRUNCATION_NOTICE);
				for (const chunk of existing.chunks) t.write(chunk);
			};
			if (termRef.current) replay();
			else requestAnimationFrame(replay);
		} else {
			setHasRun(false);
			setStatus("idle");
			setStopping(false);
			onUrlsChange?.([]);
			termRef.current?.clear();
		}

		return () => detach(workspaceId, "run", activeRunActionId);
	}, [workspaceId, activeRunActionId]);

	const handleRun = useCallback(() => {
		if (!repoId || !workspaceId || !activeRunActionId) return;
		termRef.current?.clear();
		setStatus("running");
		setHasRun(true);
		startScript(repoId, "run", workspaceId, activeRunActionId);
	}, [repoId, workspaceId, activeRunActionId]);

	const handleStop = useCallback(() => {
		if (!repoId || !workspaceId || !activeRunActionId) return;
		stopScript(repoId, "run", workspaceId, activeRunActionId);
	}, [repoId, workspaceId, activeRunActionId]);

	// Run the configured `stopCommand` standalone. Available after the
	// action has been run at least once this session (so the user has a
	// reason to clean up) — clears terminal & flips status to "running"
	// for the duration of the cleanup, then back to "exited".
	const handleCleanup = useCallback(() => {
		if (!repoId || !workspaceId || !activeRunActionId) return;
		termRef.current?.clear();
		setStatus("running");
		setHasRun(true);
		cleanupScript(repoId, workspaceId, activeRunActionId);
	}, [repoId, workspaceId, activeRunActionId]);

	// Forward keystrokes to the PTY. The backend silently ignores writes
	// when no script is live, so we don't gate this on status.
	const handleData = useCallback(
		(data: string) => {
			if (!repoId || !workspaceId || !activeRunActionId) return;
			writeStdin(repoId, "run", workspaceId, data, activeRunActionId);
		},
		[repoId, workspaceId, activeRunActionId],
	);

	const handleResize = useCallback(
		(cols: number, rows: number) => {
			if (!repoId || !workspaceId || !activeRunActionId) return;
			resizeScript(repoId, "run", workspaceId, cols, rows, activeRunActionId);
		},
		[repoId, workspaceId, activeRunActionId],
	);

	const hasScript = !!runScript?.trim();
	const trimmedStopCommand = stopCommand?.trim() ?? "";
	const autoExpandEnabled = settings.terminalHoverExpansion;
	// Auto-expand off → zoom never fires, so anchor the button unconditionally.
	const showFloatingAction =
		(status === "running" || status === "exited") &&
		(autoExpandEnabled ? isZoomPresented : true);
	// Cleanup is only useful after the action has actually started something —
	// before the first run there's nothing to tear down. Hidden while the
	// script is running (the existing Stop button covers that case, since
	// `stopRepoScript` already runs `stopCommand` as part of SIGTERM cleanup).
	const showCleanupButton =
		status === "exited" &&
		hasRun &&
		!!trimmedStopCommand &&
		!!activeRunActionId;

	return (
		<div
			id="inspector-panel-run"
			role="tabpanel"
			aria-labelledby="inspector-tab-run"
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
							detectLinks="modifier-click"
							fontSize={13}
							onData={handleData}
							onResize={handleResize}
						/>
					</div>

					{showFloatingAction && (
						// z-20 keeps the buttons above xterm's link-layer canvas (z:2).
						<div
							className="absolute right-4 bottom-3 z-20 flex items-center gap-2"
							style={
								autoExpandEnabled
									? {
											opacity: isHoverExpanded ? 1 : 0,
											pointerEvents: isHoverExpanded ? "auto" : "none",
											transition: `opacity ${TABS_HOVER_TRANSITION_MS}ms ${TABS_EASING}`,
										}
									: undefined
							}
						>
							{showCleanupButton && (
								// Surfaces the user-configured `stopCommand` after the
								// start has exited — for commands like `supabase start`
								// / `docker compose up` that leave containers running
								// after the spawned process dies. Without this, Rerun
								// is sabotaged by "already running" state and the user
								// has to drop to a real terminal to recover.
								<Button
									variant="outline"
									size="sm"
									className="text-small shadow-sm backdrop-blur-sm transition-none"
									onClick={handleCleanup}
									title={f("inspectorRunStopCommandValue", {
										command: trimmedStopCommand,
									})}
									aria-label={f("inspectorRunStopCommandValue", {
										command: trimmedStopCommand,
									})}
								>
									<CircleStop className="size-3" strokeWidth={2} />
								</Button>
							)}
							<Button
								variant={status === "running" ? "destructive" : "secondary"}
								size="sm"
								className="text-small shadow-sm backdrop-blur-sm transition-none"
								onClick={status === "running" ? handleStop : handleRun}
								disabled={status === "exited" && !hasScript}
								// Title clarifies the escalation semantic when a
								// cleanup command is still running — second click
								// short-circuits to SIGKILL on the backend.
								title={
									stopping ? t("inspectorSkipCleanupForceKill") : undefined
								}
							>
								{status === "running" ? (
									<Square className="size-3" strokeWidth={2} />
								) : (
									<RotateCcw className="size-3" strokeWidth={2} />
								)}
								{status === "running"
									? stopping
										? t("inspectorForceStop")
										: t("stop")
									: t("inspectorRerun")}
								{runShortcut ? (
									<InlineShortcutDisplay
										hotkey={runShortcut}
										className={
											status === "running"
												? "text-destructive-foreground/70"
												: "text-muted-foreground"
										}
									/>
								) : null}
							</Button>
						</div>
					)}
				</>
			) : !hasAnyRunAction ? (
				<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
					<Button
						variant="outline"
						size="sm"
						className="gap-1.5 text-small"
						onClick={onOpenSettings}
					>
						<Settings2 className="size-3.5" strokeWidth={1.8} />
						<I18nText source="addRunScript" />
					</Button>
					<p className="text-small text-muted-foreground/70">
						<I18nText source="runTestsDevelopmentServerTestChanges" />
					</p>
				</div>
			) : (
				<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
					{/* Inline the active action's name in the heading so the
					    user always sees which action the Run button will
					    trigger — important now that one workspace can have
					    several. */}
					<p className="text-ui text-muted-foreground">
						<I18nText source="noOutput" />{" "}
						<span className="font-medium text-foreground">
							{activeRunActionName ?? t("default")}
						</span>
					</p>
					<p className="text-small text-muted-foreground/70">
						<I18nText source="runScriptOutputWillAppearHere" />
					</p>
					<Button
						variant="outline"
						size="sm"
						className="mt-1 gap-2 text-small"
						onClick={handleRun}
						disabled={!hasScript}
					>
						<Play className="size-3" strokeWidth={2} />
						<I18nText source="run" />
						{runShortcut ? (
							<InlineShortcutDisplay
								hotkey={runShortcut}
								className="text-muted-foreground"
							/>
						) : null}
					</Button>
				</div>
			)}
		</div>
	);
}
