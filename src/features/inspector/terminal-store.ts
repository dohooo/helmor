import {
	resizeTerminal,
	type ScriptEvent,
	spawnTerminal,
	stopTerminal,
	writeTerminalStdin,
} from "@/lib/api";

// Module-level store for Terminal tab instances. Mirrors script-store but
// keyed per (workspace, instanceId) so multiple shells can coexist.
// In-memory only — closing the app drops every shell.

export type TerminalStatus = "running" | "exited";

export type TerminalInstance = {
	id: string;
	/** Stored on the instance so workspace lifecycle hooks (delete /
	 * archive) can stop the PTY without the caller threading `repoId`
	 * separately. */
	repoId: string;
	chunks: string[];
	bufferedBytes: number;
	truncated: boolean;
	status: TerminalStatus;
	exitCode: number | null;
	/** When true, the inspector tabs section skips its hover-zoom for this
	 * terminal so the user can keep typing without the panel resizing. */
	hoverZoomDisabled: boolean;
};

/** Positional label: 1 instance → "Terminal", 2+ → "Terminal N". */
export function getTerminalDisplayTitle(index: number, total: number): string {
	if (total <= 1) return "Terminal";
	return `Terminal ${index + 1}`;
}

/** Soft cap on concurrent terminals per workspace (memory + reflow cost). */
export const TERMINAL_INSTANCE_LIMIT = 6;

type Listener = {
	onChunk: (data: string) => void;
	onStatusChange: (status: TerminalStatus, exitCode: number | null) => void;
};

type WorkspaceListListener = (instances: TerminalInstance[]) => void;

/** ~2 MB ≈ 20k lines, well beyond xterm's 5000-line scrollback. */
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

export const TRUNCATION_NOTICE =
	"\r\n\x1b[2m… earlier output truncated (buffer limit reached) …\x1b[0m\r\n";

/** workspaceId → ordered list of terminals (left-to-right in the sub-tab row). */
const instancesByWorkspace = new Map<string, TerminalInstance[]>();
/** `${workspaceId}:${instanceId}` → live listener (the mounted xterm). */
const listeners = new Map<string, Listener>();
/** workspaceId → listeners watching the sub-tab list itself (for the strip UI). */
const workspaceListListeners = new Map<string, Set<WorkspaceListListener>>();

function listKey(workspaceId: string, instanceId: string) {
	return `${workspaceId}:${instanceId}`;
}

function appendChunk(entry: TerminalInstance, data: string) {
	entry.chunks.push(data);
	entry.bufferedBytes += data.length;
	while (entry.bufferedBytes > MAX_CHUNK_BYTES && entry.chunks.length > 1) {
		const dropped = entry.chunks.shift();
		if (dropped === undefined) break;
		entry.bufferedBytes -= dropped.length;
		entry.truncated = true;
	}
}

function emitListChange(workspaceId: string) {
	const subs = workspaceListListeners.get(workspaceId);
	if (!subs) return;
	const snapshot = [...(instancesByWorkspace.get(workspaceId) ?? [])];
	for (const sub of subs) sub(snapshot);
}

function makeId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `t-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** Snapshot of the sub-tab list for the given workspace. */
export function getTerminals(workspaceId: string): TerminalInstance[] {
	return [...(instancesByWorkspace.get(workspaceId) ?? [])];
}

/** Subscribe to list changes; fires once immediately with the snapshot. */
export function subscribeToWorkspaceList(
	workspaceId: string,
	listener: WorkspaceListListener,
): () => void {
	let set = workspaceListListeners.get(workspaceId);
	if (!set) {
		set = new Set();
		workspaceListListeners.set(workspaceId, set);
	}
	set.add(listener);
	listener([...(instancesByWorkspace.get(workspaceId) ?? [])]);
	return () => {
		const current = workspaceListListeners.get(workspaceId);
		if (!current) return;
		current.delete(listener);
		if (current.size === 0) workspaceListListeners.delete(workspaceId);
	};
}

/** Spawn a new terminal; returns null when the per-workspace cap is hit. */
export function createTerminal(
	repoId: string,
	workspaceId: string,
): TerminalInstance | null {
	const list = instancesByWorkspace.get(workspaceId) ?? [];
	if (list.length >= TERMINAL_INSTANCE_LIMIT) return null;
	const instance: TerminalInstance = {
		id: makeId(),
		repoId,
		chunks: [],
		bufferedBytes: 0,
		truncated: false,
		status: "running",
		exitCode: null,
		hoverZoomDisabled: false,
	};
	list.push(instance);
	instancesByWorkspace.set(workspaceId, list);
	emitListChange(workspaceId);

	const k = listKey(workspaceId, instance.id);
	void spawnTerminal(repoId, workspaceId, instance.id, (event: ScriptEvent) => {
		// Drop late events for instances that have been closed and removed.
		const current = instancesByWorkspace
			.get(workspaceId)
			?.find((t) => t.id === instance.id);
		if (!current) return;

		switch (event.type) {
			case "started":
				break;
			case "stdout":
			case "stderr": {
				appendChunk(current, event.data);
				listeners.get(k)?.onChunk(event.data);
				break;
			}
			case "exited": {
				current.status = "exited";
				current.exitCode = event.code;
				const tail = `\r\n\x1b[2m[Process exited with code ${
					event.code ?? "?"
				}]\x1b[0m\r\n`;
				appendChunk(current, tail);
				listeners.get(k)?.onChunk(tail);
				listeners.get(k)?.onStatusChange("exited", event.code);
				emitListChange(workspaceId);
				break;
			}
			case "error": {
				const msg = `\r\n\x1b[31m${event.message}\x1b[0m\r\n`;
				appendChunk(current, msg);
				current.status = "exited";
				current.exitCode = current.exitCode ?? 1;
				listeners.get(k)?.onChunk(msg);
				listeners.get(k)?.onStatusChange("exited", current.exitCode);
				emitListChange(workspaceId);
				break;
			}
		}
	}).catch((err) => {
		const current = instancesByWorkspace
			.get(workspaceId)
			?.find((t) => t.id === instance.id);
		if (!current) return;
		const msg = `\r\n\x1b[31mFailed to start terminal: ${err}\x1b[0m\r\n`;
		appendChunk(current, msg);
		current.status = "exited";
		current.exitCode = current.exitCode ?? 1;
		listeners.get(k)?.onChunk(msg);
		listeners.get(k)?.onStatusChange("exited", current.exitCode);
		emitListChange(workspaceId);
	});

	return instance;
}

/** SIGTERM the shell, drop the buffer, remove the tab. Destructive. */
export function closeTerminal(
	repoId: string,
	workspaceId: string,
	instanceId: string,
) {
	const list = instancesByWorkspace.get(workspaceId);
	if (!list) return;
	const idx = list.findIndex((t) => t.id === instanceId);
	if (idx === -1) return;
	const [removed] = list.splice(idx, 1);
	if (list.length === 0) {
		instancesByWorkspace.delete(workspaceId);
	} else {
		instancesByWorkspace.set(workspaceId, list);
	}
	listeners.delete(listKey(workspaceId, instanceId));
	emitListChange(workspaceId);
	// Best-effort SIGTERM; backend silently ignores if the shell already
	// exited (e.g. user typed `exit`).
	if (removed && removed.status === "running") {
		void stopTerminal(repoId, workspaceId, instanceId);
	}
}

/** Disable / enable the inspector's hover-to-zoom enlargement for a single
 * terminal so the user can keep working at the resting size without the panel
 * resizing under them. */
export function setTerminalHoverZoomDisabled(
	workspaceId: string,
	instanceId: string,
	disabled: boolean,
) {
	const list = instancesByWorkspace.get(workspaceId);
	if (!list) return;
	const entry = list.find((t) => t.id === instanceId);
	if (!entry || entry.hoverZoomDisabled === disabled) return;
	entry.hoverZoomDisabled = disabled;
	emitListChange(workspaceId);
}

/** Tear down all terminals in a workspace (fires on workspace delete). */
export function closeAllTerminalsForWorkspace(workspaceId: string) {
	const list = instancesByWorkspace.get(workspaceId);
	if (!list || list.length === 0) return;
	for (const instance of [...list]) {
		closeTerminal(instance.repoId, workspaceId, instance.id);
	}
}

/** Attach a live listener to a terminal. Returns the entry for replay, or null. */
export function attach(
	workspaceId: string,
	instanceId: string,
	listener: Listener,
): TerminalInstance | null {
	listeners.set(listKey(workspaceId, instanceId), listener);
	return (
		instancesByWorkspace.get(workspaceId)?.find((t) => t.id === instanceId) ??
		null
	);
}

export function detach(workspaceId: string, instanceId: string) {
	listeners.delete(listKey(workspaceId, instanceId));
}

export function writeStdin(
	repoId: string,
	workspaceId: string,
	instanceId: string,
	data: string,
) {
	void writeTerminalStdin(repoId, workspaceId, instanceId, data);
}

export function resize(
	repoId: string,
	workspaceId: string,
	instanceId: string,
	cols: number,
	rows: number,
) {
	void resizeTerminal(repoId, workspaceId, instanceId, cols, rows);
}
