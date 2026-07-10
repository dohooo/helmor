import {
	resizeTerminal,
	type ScriptEvent,
	setTerminalSessionBusy,
	spawnTerminal,
	stopTerminal,
	writeTerminalStdin,
} from "@/lib/api";
import { formatSource, translateSource } from "@/lib/i18n";

// Module-level store for Terminal Mode (message-area) sessions. Keyed by
// sessionId — each Terminal session owns exactly one PTY. In-memory only;
// closing the app drops every shell. Mirrors the inspector terminal-store but
// session-scoped (no per-workspace sub-tab strip).

export type TerminalSessionStatus = "running" | "exited";

type Instance = {
	sessionId: string;
	repoId: string;
	workspaceId: string;
	agentKind: string | null;
	bootCommand: string | null;
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

export type TerminalSessionSnapshot = {
	sessionId: string;
	workspaceId: string;
	agentKind: string | null;
	bootCommand: string | null;
	status: TerminalSessionStatus;
	exitCode: number | null;
};

type WorkspaceSessionListener = (sessions: TerminalSessionSnapshot[]) => void;

/** ~2 MB ≈ 20k lines, well beyond xterm's 5000-line scrollback. */
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

export function truncationNotice(): string {
	return `\r\n\x1b[2m… ${translateSource("miscEarlierOutputTruncated")} …\x1b[0m\r\n`;
}

/** sessionId → instance */
const instances = new Map<string, Instance>();
/** sessionId → live listener (the mounted xterm) */
const listeners = new Map<string, Listener>();
/** workspaceId → observers for message-area terminal sessions. */
const workspaceSessionListeners = new Map<
	string,
	Set<WorkspaceSessionListener>
>();
export type PendingBoot = {
	bootCommand: string;
	/** claude only: rides the injected --settings file (no CLI flag). */
	fastMode: boolean;
};

/** sessionId → one-shot boot for a composer-initiated terminal
 * (set before the panel mounts; consumed on first spawn). */
const pendingBoots = new Map<string, PendingBoot>();

export function setPendingBoot(sessionId: string, boot: PendingBoot) {
	pendingBoots.set(sessionId, boot);
}

export function takePendingBoot(sessionId: string): PendingBoot | null {
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

function snapshotForWorkspace(workspaceId: string): TerminalSessionSnapshot[] {
	return Array.from(instances.values())
		.filter((entry) => entry.workspaceId === workspaceId)
		.map((entry) => ({
			sessionId: entry.sessionId,
			workspaceId: entry.workspaceId,
			agentKind: entry.agentKind,
			bootCommand: entry.bootCommand,
			status: entry.status,
			exitCode: entry.exitCode,
		}));
}

function emitWorkspaceSessionChange(workspaceId: string) {
	const subs = workspaceSessionListeners.get(workspaceId);
	if (!subs) return;
	const snapshot = snapshotForWorkspace(workspaceId);
	for (const sub of subs) sub(snapshot);
}

export function getTerminalSessionsForWorkspace(
	workspaceId: string,
): TerminalSessionSnapshot[] {
	return snapshotForWorkspace(workspaceId);
}

export function subscribeToWorkspaceTerminalSessions(
	workspaceId: string,
	listener: WorkspaceSessionListener,
): () => void {
	let set = workspaceSessionListeners.get(workspaceId);
	if (!set) {
		set = new Set();
		workspaceSessionListeners.set(workspaceId, set);
	}
	set.add(listener);
	listener(snapshotForWorkspace(workspaceId));
	return () => {
		const current = workspaceSessionListeners.get(workspaceId);
		if (!current) return;
		current.delete(listener);
		if (current.size === 0) workspaceSessionListeners.delete(workspaceId);
	};
}

// TUI startup markers — everything before the first one (shell prompt,
// boot-command echo) is noise we never render. Verified by capturing both
// CLIs' boot bytes: claude enters the alternate screen (1049h); codex is an
// inline ratatui TUI that never does, but it enables focus-event reporting
// (1004h) and synchronized output (2026h) on startup. A shell's echo phase
// emits none of these (zsh only toggles bracketed paste, 2004h).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI sequences are ESC-framed.
const TUI_START_RE = /\x1b\[\?(?:1049|1047|47|2026|1004)h/;
/** Agent CLIs can take a moment to reach the TUI; past this, show everything
 * (a non-TUI command would otherwise render nothing at all). */
const BOOT_GATE_TIMEOUT_MS = 3000;

// Terminal protocol sequences (CSI / OSC / two-byte ESC) the shell emits
// before the TUI marker — bracketed paste (?2004h), cursor hide (?25l), kitty
// keyboard (>1u), etc. Their plain-text neighbours (prompt, boot echo) are
// dropped, but swallowing the sequences too desyncs xterm's mode state, so we
// replay them ahead of the visible region.
const PRELUDE_SEQ_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI is ESC-framed.
	/\x1b(?:\[[0-9;?>=]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[=>78])/g;

/** Stop gating: emit from `fromIndex` (the TUI start sequence itself must
 * reach xterm) — or everything on a timeout/exit fallback (fromIndex 0). The
 * dropped prefix's control sequences are still replayed so xterm's mode state
 * stays in sync with the TUI. */
function releaseGate(entry: Instance, fromIndex: number) {
	const gate = entry.gate;
	if (!gate) return;
	clearTimeout(gate.timer);
	entry.gate = null;
	const prelude =
		fromIndex > 0
			? (gate.buf.slice(0, fromIndex).match(PRELUDE_SEQ_RE)?.join("") ?? "")
			: "";
	const payload = prelude + gate.buf.slice(fromIndex);
	if (payload) deliver(entry, payload);
}

/** Spawn the PTY for a session if not already running. Idempotent.
 *
 * `cols`/`rows` are the renderer's real size — an inline TUI paints its first
 * frame against them, so callers spawn only once their xterm has fit. */
export function ensureTerminal(
	repoId: string,
	workspaceId: string,
	sessionId: string,
	bootCommand: string | null,
	agentKind: string | null,
	fastMode = false,
	cols?: number | null,
	rows?: number | null,
) {
	if (instances.has(sessionId)) return;
	const entry: Instance = {
		sessionId,
		repoId,
		workspaceId,
		agentKind,
		bootCommand,
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
	emitWorkspaceSessionChange(workspaceId);

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
						const match = TUI_START_RE.exec(current.gate.buf);
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
					const tail = `\r\n\x1b[2m${formatSource("miscProcessExitedWithCode", {
						code: event.code ?? "?",
					})}\x1b[0m\r\n`;
					appendChunk(current, tail);
					listeners.get(sessionId)?.onChunk(tail);
					listeners.get(sessionId)?.onStatusChange("exited", event.code);
					emitWorkspaceSessionChange(current.workspaceId);
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
					emitWorkspaceSessionChange(current.workspaceId);
					break;
				}
			}
		},
		bootCommand,
		agentKind,
		fastMode,
		cols,
		rows,
	).catch((err) => {
		const current = instances.get(sessionId);
		if (!current) return;
		const msg = `\r\n\x1b[31m${formatSource("miscFailedStartTerminal", {
			error: String(err),
		})}\x1b[0m\r\n`;
		appendChunk(current, msg);
		current.status = "exited";
		current.exitCode = current.exitCode ?? 1;
		listeners.get(sessionId)?.onChunk(msg);
		listeners.get(sessionId)?.onStatusChange("exited", current.exitCode);
		emitWorkspaceSessionChange(current.workspaceId);
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
	// NOTE: no ESC-keypress interrupt heuristic here, and don't re-add one.
	// claude fires NO hook on a user interrupt (Stop is documented as not
	// running then), so interrupt inference IS needed — but it lives in the
	// backend off this same write (terminal::observe_stdin in src-tauri). A
	// renderer-side heuristic was removed because each misfire kicked an IPC
	// + session-list invalidation whose re-render could break an in-flight
	// IME composition (typing went dead until a session switch).
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
	emitWorkspaceSessionChange(entry.workspaceId);
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

/** Reset all state. Test-only. */
export function __resetTerminalSessionsForTests() {
	for (const entry of instances.values()) {
		if (entry.gate) clearTimeout(entry.gate.timer);
	}
	instances.clear();
	listeners.clear();
	workspaceSessionListeners.clear();
	pendingBoots.clear();
}
