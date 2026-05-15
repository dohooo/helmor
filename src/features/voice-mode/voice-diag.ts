import { invoke } from "@tauri-apps/api/core";

/**
 * Unified diagnostic-event channel for the voice-mode subsystem.
 *
 * Why this exists: the voice-panel webview is transparent and
 * chrome-less, so it has no surfaceable devtools console — anything
 * the panel's React tree does is otherwise invisible. We forward
 * every notable lifecycle event to the Rust tracing log via the
 * `record_voice_panel_event` Tauri command, where it joins the rest
 * of the JSONL trace at `{data_dir}/logs/rust.jsonl` under the
 * `helmor_lib::voice_panel` target. Operators can grep one place
 * for the full timeline.
 *
 * The main window webview also calls this — its events are
 * indistinguishable from the panel's in the log, which is fine
 * because the same dispatcher runs in both surfaces and the
 * questions you ask the log are about voice flow, not which webview
 * spawned it.
 *
 * Conventions:
 * - `event` follows the `domain.action` pattern: `dispatcher.tool-call-start`,
 *   `session.peer-state`, `sequence.phase`, `panel-active-event`.
 *   Operators grep by prefix.
 * - `data` is a flat object of JSON-serializable values. Keep it
 *   small — kilobytes of base64 or full event payloads choke the log
 *   viewer; record sizes and ids instead.
 * - Fire-and-forget. An IPC failure here is never fatal to the
 *   Realtime session; we `console.warn` and move on.
 */
export function voiceDiag(event: string, data?: Record<string, unknown>) {
	void invoke("record_voice_panel_event", {
		event,
		data: data ?? null,
	}).catch((err) => {
		console.warn("[helmor voice] diag echo failed", event, err);
	});
}
