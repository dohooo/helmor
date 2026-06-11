import {
	resizeTerminal,
	type ScriptEvent,
	setTerminalSessionBusy,
	spawnTerminal,
	stopTerminal,
	writeTerminalStdin,
} from "@/lib/api";

// Module-level store for Terminal Mode (message-area) sessions. Keyed by
// sessionId — each Terminal session owns exactly one PTY. In-memory only;
// closing the app drops every shell. Mirrors the inspector terminal-store but
// session-scoped (no per-workspace sub-tab strip).

export type TerminalSessionStatus = "running" | "exited";

type Instance = {
	sessionId: string;
	repoId: string;
	workspaceId: string;
	chunks: string[];
	bufferedBytes: number;
	truncated: boolean;
	status: TerminalSessionStatus;
	exitCode: number | null;
	/** Pre-TUI output held back so the shell prompt + boot-command echo never
	 * render; released from the TUI's alt-screen enter (or on timeout). */
	gate: { buf: string; timer: ReturnType<typeof setTimeout> } | null;
};

type Listener = {
	onChunk: (data: string) => void;
	onStatusChange: (
		status: TerminalSessionStatus,
		exitCode: number | null,
	) => void;
};

/** ~2 MB ≈ 20k lines, well beyond xterm's 5000-line scrollback. */
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

export const TRUNCATION_NOTICE =
	"\r\n\x1b[2m… earlier output truncated (buffer limit reached) …\x1b[0m\r\n";

/** sessionId → instance */
const instances = new Map<string, Instance>();
/** sessionId → live listener (the mounted xterm) */
const listeners = new Map<string, Listener>();
/** sessionId → one-shot boot command for a composer-initiated terminal
 * (set before the panel mounts; consumed on first spawn). */
const pendingBoots = new Map<string, string>();

export function setPendingBoot(sessionId: string, bootCommand: string) {
	pendingBoots.set(sessionId, bootCommand);
}

export function takePendingBoot(sessionId: string): string | null {
	const boot = pendingBoots.get(sessionId) ?? null;
	pendingBoots.delete(sessionId);
	return boot;
}

function appendChunk(entry: Instance, data: string) {
	entry.chunks.push(data);
	entry.bufferedBytes += data.length;
	while (entry.bufferedBytes > MAX_CHUNK_BYTES && entry.chunks.length > 1) {
		const dropped = entry.chunks.shift();
		if (dropped === undefined) break;
		entry.bufferedBytes -= dropped.length;
		entry.truncated = true;
	}
}

function deliver(entry: Instance, data: string) {
	appendChunk(entry, data);
	listeners.get(entry.sessionId)?.onChunk(data);
}

// claude/codex TUIs enter the alternate screen on startup; everything before
// that (shell prompt, boot-command echo) is noise we never render.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI alt-screen sequences are ESC-framed.
const ALT_SCREEN_ENTER_RE = /\x1b\[\?(?:1049|1047|47)h/;
/** Agent CLIs can take a moment to reach the TUI; past this, show everything
 * (a non-TUI command would otherwise render nothing at all). */
const BOOT_GATE_TIMEOUT_MS = 3000;

/** Stop gating: emit from `fromIndex` (the alt-screen sequence itself must
 * reach xterm) — or everything on a timeout/exit fallback (fromIndex 0). */
function releaseGate(entry: Instance, fromIndex: number) {
	const gate = entry.gate;
	if (!gate) return;
	clearTimeout(gate.timer);
	entry.gate = null;
	const visible = gate.buf.slice(fromIndex);
	if (visible) deliver(entry, visible);
}

/** Spawn the PTY for a session if not already running. Idempotent. */
export function ensureTerminal(
	repoId: string,
	workspaceId: string,
	sessionId: string,
	bootCommand: string | null,
	agentKind: string | null,
) {
	if (instances.has(sessionId)) return;
	const entry: Instance = {
		sessionId,
		repoId,
		workspaceId,
		chunks: [],
		bufferedBytes: 0,
		truncated: false,
		status: "running",
		exitCode: null,
		// Gate only agent boots — a bare shell has no TUI to wait for.
		gate:
			agentKind && bootCommand
				? {
						buf: "",
						timer: setTimeout(() => {
							const current = instances.get(sessionId);
							if (current) releaseGate(current, 0);
						}, BOOT_GATE_TIMEOUT_MS),
					}
				: null,
	};
	instances.set(sessionId, entry);

	void spawnTerminal(
		repoId,
		workspaceId,
		sessionId,
		(event: ScriptEvent) => {
			const current = instances.get(sessionId);
			if (!current) return;
			switch (event.type) {
				case "started":
					break;
				case "stdout":
				case "stderr": {
					if (current.gate) {
						current.gate.buf += event.data;
						const match = ALT_SCREEN_ENTER_RE.exec(current.gate.buf);
						if (match) releaseGate(current, match.index);
						break;
					}
					deliver(current, event.data);
					break;
				}
				case "exited": {
					releaseGate(current, 0);
					void setTerminalSessionBusy(
						current.sessionId,
						current.workspaceId,
						false,
					).catch(() => {});
					current.status = "exited";
					current.exitCode = event.code;
					const tail = `\r\n\x1b[2m[Process exited with code ${
						event.code ?? "?"
					}]\x1b[0m\r\n`;
					appendChunk(current, tail);
					listeners.get(sessionId)?.onChunk(tail);
					listeners.get(sessionId)?.onStatusChange("exited", event.code);
					break;
				}
				case "error": {
					releaseGate(current, 0);
					const msg = `\r\n\x1b[31m${event.message}\x1b[0m\r\n`;
					appendChunk(current, msg);
					void setTerminalSessionBusy(
						current.sessionId,
						current.workspaceId,
						false,
					).catch(() => {});
					current.status = "exited";
					current.exitCode = current.exitCode ?? 1;
					listeners.get(sessionId)?.onChunk(msg);
					listeners.get(sessionId)?.onStatusChange("exited", current.exitCode);
					break;
				}
			}
		},
		bootCommand,
		agentKind,
	).catch((err) => {
		const current = instances.get(sessionId);
		if (!current) return;
		const msg = `\r\n\x1b[31mFailed to start terminal: ${err}\x1b[0m\r\n`;
		appendChunk(current, msg);
		current.status = "exited";
		current.exitCode = current.exitCode ?? 1;
		listeners.get(sessionId)?.onChunk(msg);
		listeners.get(sessionId)?.onStatusChange("exited", current.exitCode);
	});
}

/** Attach a live listener; returns the instance for one-shot replay, or null. */
export function attach(sessionId: string, listener: Listener): Instance | null {
	listeners.set(sessionId, listener);
	return instances.get(sessionId) ?? null;
}

export function detach(sessionId: string) {
	listeners.delete(sessionId);
}

export function writeStdin(sessionId: string, data: string) {
	const entry = instances.get(sessionId);
	if (!entry) return;
	void writeTerminalStdin(entry.repoId, entry.workspaceId, sessionId, data);
}

export function resize(sessionId: string, cols: number, rows: number) {
	const entry = instances.get(sessionId);
	if (!entry) return;
	void resizeTerminal(entry.repoId, entry.workspaceId, sessionId, cols, rows);
}

/** SIGTERM the shell, drop the buffer, forget the session. Destructive. */
export function closeTerminal(sessionId: string) {
	const entry = instances.get(sessionId);
	if (!entry) return;
	if (entry.gate) clearTimeout(entry.gate.timer);
	instances.delete(sessionId);
	listeners.delete(sessionId);
	if (entry.status === "running") {
		void stopTerminal(entry.repoId, entry.workspaceId, sessionId);
	}
	// Clear busy HERE: the exited event lands after the instance is deleted
	// (its callback early-returns), and a SIGTERM'd agent never fires its Stop
	// hook — without this, a working terminal's spinner leaks until restart.
	void setTerminalSessionBusy(sessionId, entry.workspaceId, false).catch(
		() => {},
	);
}
