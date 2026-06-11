import type { Terminal } from "@xterm/xterm";

// Per-terminal write scheduler. A foreground (visible) terminal with nothing
// queued writes straight through — zero added latency for the active tab.
// Background terminals coalesce writes and drain on a timer, a few terminals
// per tick, so N hidden shells can't starve the foreground one or the main
// thread. Mirrors orca's output scheduler.

const BACKGROUND_FLUSH_DELAY_MS = 50;
const FOREGROUND_FLUSH_DELAY_MS = 8;
const DRAIN_CHUNK_CHARS = 16 * 1024;
const MAX_TERMINALS_PER_DRAIN = 2;
// Matches the terminal-store ring-buffer cap so a one-shot replay (≤2MB) is
// never truncated; a sustained background producer past this drops oldest.
const MAX_QUEUE_CHARS = 2 * 1024 * 1024;
// Cap the first flush when a terminal becomes visible so it paints fast; the
// remainder rides the normal foreground drain.
const VISIBLE_FLUSH_MAX_CHARS = 256 * 1024;

type Entry = {
	chunks: string[];
	chars: number;
	foreground: boolean;
};

const queues = new Map<Terminal, Entry>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainDelayMs = Number.POSITIVE_INFINITY;

function scheduleDrain(delayMs: number): void {
	if (drainTimer !== null && drainDelayMs <= delayMs) return;
	if (drainTimer !== null) clearTimeout(drainTimer);
	drainDelayMs = delayMs;
	drainTimer = setTimeout(() => {
		drainTimer = null;
		drainDelayMs = Number.POSITIVE_INFINITY;
		drain();
	}, delayMs);
}

// Write up to `budget` chars from the entry, slicing a chunk that straddles
// the budget. Returns true if the entry still has buffered data.
function writeFromEntry(
	terminal: Terminal,
	entry: Entry,
	budget: number,
): boolean {
	const out: string[] = [];
	let remaining = budget;
	while (entry.chunks.length > 0 && remaining > 0) {
		const chunk = entry.chunks[0];
		if (chunk.length <= remaining) {
			out.push(chunk);
			remaining -= chunk.length;
			entry.chars -= chunk.length;
			entry.chunks.shift();
		} else {
			out.push(chunk.slice(0, remaining));
			entry.chunks[0] = chunk.slice(remaining);
			entry.chars -= remaining;
			remaining = 0;
		}
	}
	if (out.length > 0) terminal.write(out.join(""));
	return entry.chunks.length > 0;
}

function drain(): void {
	let processed = 0;
	for (const [terminal, entry] of [...queues]) {
		if (processed >= MAX_TERMINALS_PER_DRAIN) break;
		// Round-robin fairness: re-insert a still-buffered entry at the tail
		// so Map iteration starts from the unserved terminals next tick —
		// otherwise >2 chatty background shells starve everyone behind them.
		queues.delete(terminal);
		if (writeFromEntry(terminal, entry, DRAIN_CHUNK_CHARS)) {
			queues.set(terminal, entry);
		}
		processed += 1;
	}
	if (queues.size > 0) {
		const anyForeground = [...queues.values()].some((e) => e.foreground);
		scheduleDrain(
			anyForeground ? FOREGROUND_FLUSH_DELAY_MS : BACKGROUND_FLUSH_DELAY_MS,
		);
	}
}

/** Queue (or directly write) terminal output. */
export function scheduleTerminalWrite(
	terminal: Terminal,
	data: string,
	opts: { foreground: boolean },
): void {
	if (!data) return;
	let entry = queues.get(terminal);
	// Fast path: visible terminal, empty queue → write now (preserves the
	// pre-scheduler zero-latency behaviour for the active tab).
	if (opts.foreground && entry === undefined) {
		terminal.write(data);
		return;
	}
	if (entry === undefined) {
		entry = { chunks: [], chars: 0, foreground: opts.foreground };
		queues.set(terminal, entry);
	} else if (opts.foreground) {
		entry.foreground = true;
	}
	entry.chunks.push(data);
	entry.chars += data.length;
	// Backpressure: drop oldest chunks once over the cap.
	while (entry.chars > MAX_QUEUE_CHARS && entry.chunks.length > 1) {
		const dropped = entry.chunks.shift();
		if (dropped === undefined) break;
		entry.chars -= dropped.length;
	}
	scheduleDrain(
		entry.foreground ? FOREGROUND_FLUSH_DELAY_MS : BACKGROUND_FLUSH_DELAY_MS,
	);
}

/**
 * Flush queued output now (used when a terminal becomes visible). Writes up to
 * `maxChars` synchronously; any remainder stays queued for the normal drain.
 */
export function flushTerminalWrites(
	terminal: Terminal,
	opts?: { maxChars?: number },
): void {
	const entry = queues.get(terminal);
	if (entry === undefined) return;
	const maxChars = opts?.maxChars ?? VISIBLE_FLUSH_MAX_CHARS;
	if (writeFromEntry(terminal, entry, maxChars)) {
		entry.foreground = true;
		scheduleDrain(FOREGROUND_FLUSH_DELAY_MS);
	} else {
		queues.delete(terminal);
	}
}

/** Drop queued output for a terminal (used on xterm.clear()). */
export function clearTerminalWrites(terminal: Terminal): void {
	queues.delete(terminal);
}

/** Remove a terminal from the scheduler entirely (used on unmount/dispose). */
export function disposeTerminalWrites(terminal: Terminal): void {
	queues.delete(terminal);
	if (queues.size === 0 && drainTimer !== null) {
		clearTimeout(drainTimer);
		drainTimer = null;
		drainDelayMs = Number.POSITIVE_INFINITY;
	}
}
