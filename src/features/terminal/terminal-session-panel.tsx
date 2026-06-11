import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
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
}: TerminalSessionPanelProps) {
	const queryClient = useQueryClient();
	const termRef = useRef<TerminalHandle | null>(null);
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

	useEffect(() => {
		if (!repoId) return;
		// A composer-initiated terminal carries its own boot (prompt + composer
		// state, incl. fast mode); ensureTerminal is idempotent so the consumed
		// value only matters on the spawning mount.
		const pending = takePendingBoot(sessionId);
		const boot = pending?.bootCommand ?? bootCommandRef.current ?? null;
		ensureTerminal(
			repoId,
			workspaceId,
			sessionId,
			boot,
			agentKind,
			pending?.fastMode ?? false,
		);
		const existing = attach(sessionId, {
			onChunk: (data) => termRef.current?.write(data),
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
	}, [repoId, workspaceId, sessionId, agentKind]);

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
		(cols: number, rows: number) => resize(sessionId, cols, rows),
		[sessionId],
	);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<TerminalOutput
				terminalRef={termRef}
				className="h-full"
				onData={handleData}
				onResize={handleResize}
				isVisible={isActive}
			/>
		</div>
	);
}
