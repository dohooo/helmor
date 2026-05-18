import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import {
	attach,
	detach,
	resize,
	type TerminalInstance,
	TRUNCATION_NOTICE,
	writeStdin,
} from "../terminal-store";

// Global queue serializing xterm mounts one-per-RAF. When a workspace
// with N terminals re-mounts (e.g. on workspace switch), without this
// queue all N panels would call `new Terminal() + open()` synchronously
// in the same React commit (~50–150ms each), stalling the main thread
// for half a second or more. With the queue, each panel waits its turn,
// so the cost is amortised across N animation frames.
const pendingXtermMounts: Array<() => void> = [];
let xtermDrainScheduled = false;
function drainXtermQueue() {
	if (pendingXtermMounts.length === 0) {
		xtermDrainScheduled = false;
		return;
	}
	requestAnimationFrame(() => {
		const cb = pendingXtermMounts.shift();
		if (cb) cb();
		drainXtermQueue();
	});
}
function scheduleXtermMount(callback: () => void): () => void {
	let cancelled = false;
	const wrapped = () => {
		if (!cancelled) callback();
	};
	pendingXtermMounts.push(wrapped);
	if (!xtermDrainScheduled) {
		xtermDrainScheduled = true;
		drainXtermQueue();
	}
	return () => {
		cancelled = true;
	};
}

type TerminalInstancePanelProps = {
	repoId: string | null;
	workspaceId: string | null;
	instance: TerminalInstance;
	isActive: boolean;
};

/** Single terminal panel; xterm stays mounted across tab switches (CSS-hidden). */
export function TerminalInstancePanel({
	repoId,
	workspaceId,
	instance,
	isActive,
}: TerminalInstancePanelProps) {
	const termRef = useRef<TerminalHandle | null>(null);
	const instanceId = instance.id;

	// Stagger xterm construction across frames so an N-terminal workspace
	// re-mount doesn't run N synchronous `new Terminal() + open()` in the
	// same commit and stall the main thread.
	const [renderXterm, setRenderXterm] = useState(false);
	useEffect(() => {
		const cancel = scheduleXtermMount(() => setRenderXterm(true));
		return cancel;
	}, []);

	// Attach + one-shot replay on mount; live listener carries chunks afterwards.
	useEffect(() => {
		if (!workspaceId) return;
		const existing = attach(workspaceId, instanceId, {
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
				// Snapshot to avoid re-writing chunks that the live listener already painted.
				const snapshot = existing.chunks.slice();
				t.clear();
				if (existing.truncated) t.write(TRUNCATION_NOTICE);
				for (const chunk of snapshot) t.write(chunk);
			}
			// Auto-focus on first mount if this panel is the active one.
			if (isActive) t.focus();
		};
		tryReplay();

		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
			detach(workspaceId, instanceId);
		};
		// isActive deliberately not in deps — handled by the [isActive] effect below.
	}, [workspaceId, instanceId]);

	// Refit + focus on activate (xterm size may have drifted while hidden).
	useEffect(() => {
		if (!isActive) return;
		const id = requestAnimationFrame(() => {
			const t = termRef.current;
			if (!t) return;
			t.refit();
			t.focus();
		});
		return () => cancelAnimationFrame(id);
	}, [isActive]);

	// Focus this xterm when the global focus-terminal shortcut fires.
	useEffect(() => {
		if (!isActive) return;
		const handler = () => termRef.current?.focus();
		window.addEventListener("helmor:focus-active-terminal", handler);
		return () =>
			window.removeEventListener("helmor:focus-active-terminal", handler);
	}, [isActive]);

	const handleData = useCallback(
		(data: string) => {
			if (!repoId || !workspaceId) return;
			writeStdin(repoId, workspaceId, instanceId, data);
		},
		[repoId, workspaceId, instanceId],
	);

	const handleResize = useCallback(
		(cols: number, rows: number) => {
			if (!repoId || !workspaceId) return;
			resize(repoId, workspaceId, instanceId, cols, rows);
		},
		[repoId, workspaceId, instanceId],
	);

	return (
		<div
			id={`inspector-panel-terminal-${instance.id}`}
			role="tabpanel"
			aria-labelledby={`inspector-tab-terminal-${instance.id}`}
			// `hidden` = display:none → inactive xterm DOM out of layout
			// (matches Setup/Run; saves reflow cost during inspector resize).
			hidden={!isActive}
			className="relative flex min-h-0 flex-1 flex-col"
		>
			{renderXterm ? (
				<TerminalOutput
					terminalRef={termRef}
					className="h-full"
					onData={handleData}
					onResize={handleResize}
				/>
			) : null}
		</div>
	);
}
