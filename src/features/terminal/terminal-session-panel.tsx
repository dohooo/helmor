import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { helmorQueryKeys } from "@/lib/query-client";
import { presetBootCommand, resumeBootCommand } from "./terminal-presets";
import {
	attach,
	detach,
	ensureTerminal,
	type PendingBoot,
	resize,
	TRUNCATION_NOTICE,
	takePendingBoot,
	writeStdin,
} from "./terminal-session-store";

type TerminalSessionPanelProps = {
	repoId: string | null;
	workspaceId: string;
	sessionId: string;
	/** Preset CLI key (sessions.agentType); null = bare shell. */
	agentKind?: string | null;
	/** Agent's real session id captured by the hook; non-null → resume. */
	providerSessionId?: string | null;
	/** False while CSS-hidden by a session switch: releases WebGL and skips
	 *  focus, but the xterm instance and its buffer stay alive. */
	isActive?: boolean;
	/** False while the workspace is still initializing (start-surface create
	 *  before finalize) — the PTY must not spawn until the worktree exists. */
	workspaceReady?: boolean;
};

const AGENT_LABELS: Record<string, string> = {
	claude: "Claude",
	codex: "Codex",
};

/** Message-area terminal for a Terminal session. The panel stays mounted
 * across session switches (parent CSS-hides it) because a TUI's incremental
 * ANSI output can't be replayed correctly against a fresh screen; replay only
 * runs on the first mount of a session. */
export function TerminalSessionPanel({
	repoId,
	workspaceId,
	sessionId,
	agentKind = null,
	providerSessionId = null,
	isActive = true,
	workspaceReady = true,
}: TerminalSessionPanelProps) {
	const queryClient = useQueryClient();
	const termRef = useRef<TerminalHandle | null>(null);
	// Spawn-to-first-byte takes a moment (worktree finalize + CLI cold start
	// + the boot-echo gate); show an overlay instead of a blank screen.
	const [booting, setBooting] = useState(true);
	// Resume the agent's prior session when we have its id at mount time;
	// otherwise run the fresh preset command. (M4) Pinned in a ref: the boot
	// only matters on the spawning mount, and `providerSessionId` appearing
	// after the first turn must NOT re-run the effect — its clear()+replay
	// would corrupt the live TUI's screen.
	const bootCommandRef = useRef<string | null | undefined>(undefined);
	if (bootCommandRef.current === undefined) {
		// Linked directories ride along on resume (claude's --add-dir is a
		// process-level grant). Cache read only — a cold cache just resumes
		// without them, same as before the feature existed.
		const addDirs = queryClient.getQueryData<readonly string[]>(
			helmorQueryKeys.workspaceLinkedDirectories(workspaceId),
		);
		bootCommandRef.current =
			(providerSessionId
				? resumeBootCommand(agentKind, providerSessionId, { addDirs })
				: null) ?? presetBootCommand(agentKind);
	}

	// Consume the composer-initiated boot once (prompt + composer state, incl.
	// fast mode). Lazy-init ref so an effect re-run never re-reads it as null.
	const pendingBootRef = useRef<PendingBoot | null | undefined>(undefined);
	if (pendingBootRef.current === undefined) {
		pendingBootRef.current = takePendingBoot(sessionId);
	}
	const pendingPrompt = pendingBootRef.current?.prompt ?? null;

	// Spawn the PTY at the renderer's real size — an inline TUI paints its
	// first frame against it, so we wait for the first fit. `spawnedRef` keeps
	// it one-shot across the resize handler and the workspace-ready effect.
	const spawnedRef = useRef(false);
	const sizeRef = useRef<{ cols: number; rows: number } | null>(null);

	const maybeSpawn = useCallback(() => {
		if (spawnedRef.current || !repoId || !workspaceReady) return;
		const size = sizeRef.current;
		if (!size) return;
		spawnedRef.current = true;
		const pending = pendingBootRef.current;
		const boot = pending?.bootCommand ?? bootCommandRef.current ?? null;
		ensureTerminal(
			repoId,
			workspaceId,
			sessionId,
			boot,
			agentKind,
			pending?.fastMode ?? false,
			size.cols,
			size.rows,
		);
	}, [repoId, workspaceReady, workspaceId, sessionId, agentKind]);

	// Attach the live listener + one-shot replay. Independent of spawn: the
	// listener is keyed by sessionId and receives output once the PTY starts.
	useEffect(() => {
		const existing = attach(sessionId, {
			onChunk: (data) => {
				setBooting(false);
				termRef.current?.write(data);
			},
			onStatusChange: () => {},
		});

		let rafId: number | null = null;
		const tryReplay = () => {
			rafId = null;
			const t = termRef.current;
			if (!t) {
				rafId = requestAnimationFrame(tryReplay);
				return;
			}
			if (existing && existing.chunks.length > 0) {
				setBooting(false);
				const snapshot = existing.chunks.slice();
				t.clear();
				if (existing.truncated) t.write(TRUNCATION_NOTICE);
				for (const chunk of snapshot) t.write(chunk);
			}
		};
		tryReplay();

		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
			detach(sessionId);
		};
	}, [sessionId]);

	// Try to spawn once the workspace is ready (the first fit may already have
	// landed a size before finalize completed).
	useEffect(() => {
		maybeSpawn();
	}, [maybeSpawn]);

	// Focus follows visibility, not mount — switching back to a kept-mounted
	// terminal should put the cursor in it again.
	useEffect(() => {
		if (isActive) termRef.current?.focus();
	}, [isActive]);

	const handleData = useCallback(
		(data: string) => writeStdin(sessionId, data),
		[sessionId],
	);
	const handleResize = useCallback(
		(cols: number, rows: number) => {
			sizeRef.current = { cols, rows };
			// First fit → spawn at the real size; later fits → resize the PTY
			// (resize no-ops until the instance exists).
			maybeSpawn();
			resize(sessionId, cols, rows);
		},
		[sessionId, maybeSpawn],
	);

	const agentLabel = (agentKind && AGENT_LABELS[agentKind]) || "terminal";

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<TerminalOutput
				terminalRef={termRef}
				className="h-full"
				onData={handleData}
				onResize={handleResize}
				isVisible={isActive}
			/>
			{booting ? (
				pendingPrompt ? (
					// Fake-TUI waiting state: echo the prompt + a thinking spinner so
					// the worktree finalize + CLI cold start reads as "the agent is
					// already working", not a stalled blank screen.
					<div className="absolute inset-0 z-10 flex flex-col gap-3 bg-terminal-background px-4 py-3 font-mono text-small">
						<div className="flex gap-2 text-terminal-foreground">
							<span className="text-muted-foreground">❯</span>
							<span className="whitespace-pre-wrap break-words">
								{pendingPrompt}
							</span>
						</div>
						<div className="flex items-center gap-2 text-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
							<span>Waiting for {agentLabel}…</span>
						</div>
					</div>
				) : (
					<div className="absolute inset-0 z-10 flex items-center justify-center bg-panel">
						<div className="flex items-center gap-2.5 text-small text-muted-foreground">
							<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
							<span>
								{workspaceReady
									? `Starting ${agentLabel}…`
									: "Preparing workspace…"}
							</span>
						</div>
					</div>
				)
			) : null}
		</div>
	);
}
