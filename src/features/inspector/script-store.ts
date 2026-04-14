import { executeRepoScript, type ScriptEvent, stopRepoScript } from "@/lib/api";

export type ScriptStatus = "idle" | "running" | "exited";

type Listener = {
	onChunk: (data: string) => void;
	onStatusChange: (status: ScriptStatus) => void;
};

type ScriptEntry = {
	chunks: string[];
	status: ScriptStatus;
	exitCode: number | null;
	listener: Listener | null;
};

/** Module-level store — survives React mount/unmount cycles. */
const entries = new Map<string, ScriptEntry>();

function key(workspaceId: string, scriptType: string) {
	return `${workspaceId}:${scriptType}`;
}

export function getScriptState(workspaceId: string, scriptType: string) {
	return entries.get(key(workspaceId, scriptType)) ?? null;
}

export function startScript(
	repoId: string,
	scriptType: "setup" | "run",
	workspaceId: string,
) {
	const k = key(workspaceId, scriptType);

	// If there's already a running entry, its output will be replaced.
	const entry: ScriptEntry = {
		chunks: [],
		status: "running",
		exitCode: null,
		listener: entries.get(k)?.listener ?? null,
	};
	entries.set(k, entry);

	entry.listener?.onStatusChange("running");

	executeRepoScript(
		repoId,
		scriptType,
		(event: ScriptEvent) => {
			// Guard: entry may have been replaced by a new run.
			if (entries.get(k) !== entry) return;

			switch (event.type) {
				case "started":
					break;
				case "stdout":
				case "stderr":
					entry.chunks.push(event.data);
					entry.listener?.onChunk(event.data);
					break;
				case "exited":
					entry.status = "exited";
					entry.exitCode = event.code;
					entry.listener?.onStatusChange("exited");
					break;
				case "error": {
					const msg = `\r\n\x1b[31m${event.message}\x1b[0m\r\n`;
					entry.chunks.push(msg);
					entry.status = "exited";
					entry.listener?.onChunk(msg);
					entry.listener?.onStatusChange("exited");
					break;
				}
			}
		},
		workspaceId,
	).catch((err) => {
		if (entries.get(k) !== entry) return;
		const msg = `\r\n\x1b[31mFailed to start: ${err}\x1b[0m\r\n`;
		entry.chunks.push(msg);
		entry.status = "exited";
		entry.listener?.onChunk(msg);
		entry.listener?.onStatusChange("exited");
	});
}

export function stopScript(
	repoId: string,
	scriptType: "setup" | "run",
	workspaceId: string,
) {
	void stopRepoScript(repoId, scriptType, workspaceId);
}

/** Attach a live listener. Returns current state for replay, or null. */
export function attach(
	workspaceId: string,
	scriptType: string,
	listener: Listener,
): ScriptEntry | null {
	const k = key(workspaceId, scriptType);
	const entry = entries.get(k);
	if (entry) {
		entry.listener = listener;
		return entry;
	}
	return null;
}

/** Detach the live listener (entry stays alive). */
export function detach(workspaceId: string, scriptType: string) {
	const entry = entries.get(key(workspaceId, scriptType));
	if (entry) {
		entry.listener = null;
	}
}
