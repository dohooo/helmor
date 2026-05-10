import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type RealtimeServerEvent,
	type RealtimeVoiceSession,
	startRealtimeVoiceSession,
} from "./realtime-session";
import { createToolDispatcher } from "./tool-dispatcher";
import { useAudioLevel } from "./use-audio-level";
import {
	getMinHold,
	type VoiceUiPhase,
	type VoiceUiState,
} from "./voice-mode-state";

/** How long the `done` phase lingers before flipping back to listening. */
const DONE_LINGER_MS = 1200;

/**
 * Realtime API-driven counterpart to `useDemoSequence`. Same output
 * shape (`VoiceUiState`), but the phase comes from OpenAI Realtime
 * dataChannel events and `level` comes from a real AnalyserNode on the
 * user's mic / the model's TTS stream.
 *
 * Lifecycle: `active` flips false -> true mints an ephemeral key and
 * starts a WebRTC session. `active` flips back to false (or component
 * unmounts) tears the session down. Each ON is a fresh session -- we
 * don't try to resume across toggles in this first cut.
 *
 * MIN_HOLD: `thinking` holds for at least `getMinHold("thinking")` ms
 * even if the next event arrives instantly, so the phase never flashes
 * past. Other transitions are immediate.
 */
export function useRealtimeSequence(active: boolean): VoiceUiState {
	const [phase, setPhase] = useState<VoiceUiPhase>("listening");
	const [label, setLabel] = useState<string | undefined>();
	const [summary, setSummary] = useState<string | undefined>();
	const [tone, setTone] = useState<"error" | undefined>();
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

	const micLevel = useAudioLevel(localStream);
	const ttsLevel = useAudioLevel(remoteStream);

	// Refs hold "current" values for use inside async event handlers
	// without re-binding the handler every render.
	const phaseRef = useRef<VoiceUiPhase>("listening");
	const phaseStartRef = useRef(performance.now());
	const pendingTransitionRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const doneLingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const applyPhase = useCallback(
		(
			next: VoiceUiPhase,
			opts: {
				label?: string;
				summary?: string;
				tone?: "error";
			} = {},
		) => {
			phaseRef.current = next;
			phaseStartRef.current = performance.now();
			setPhase(next);
			setLabel(opts.label);
			setSummary(opts.summary);
			setTone(opts.tone);
		},
		[],
	);

	const transitionWithHold = useCallback(
		(
			next: VoiceUiPhase,
			opts: { label?: string; summary?: string; tone?: "error" } = {},
		) => {
			if (pendingTransitionRef.current) {
				clearTimeout(pendingTransitionRef.current);
				pendingTransitionRef.current = null;
			}
			const elapsed = performance.now() - phaseStartRef.current;
			const minHold = getMinHold(phaseRef.current);
			const remaining = Math.max(0, minHold - elapsed);
			if (remaining === 0) {
				applyPhase(next, opts);
			} else {
				pendingTransitionRef.current = setTimeout(() => {
					pendingTransitionRef.current = null;
					applyPhase(next, opts);
				}, remaining);
			}
		},
		[applyPhase],
	);

	useEffect(() => {
		if (!active) {
			// Reset to clean baseline when voice mode toggles off. Any
			// pending transition or done-linger timers get cleared by the
			// effect cleanup below (this branch returns early before
			// scheduling anything new).
			applyPhase("listening");
			return;
		}

		let cancelled = false;
		let session: RealtimeVoiceSession | null = null;

		const handleEvent = (event: RealtimeServerEvent) => {
			const eventType = event.type;
			if (!eventType) return;

			if (eventType === "input_audio_buffer.speech_started") {
				// Snap any in-flight transition back to listening so user
				// barge-in is immediate (cancels pending thinking-hold etc.).
				if (pendingTransitionRef.current) {
					clearTimeout(pendingTransitionRef.current);
					pendingTransitionRef.current = null;
				}
				if (doneLingerRef.current) {
					clearTimeout(doneLingerRef.current);
					doneLingerRef.current = null;
				}
				if (phaseRef.current !== "listening") {
					applyPhase("listening");
				}
				return;
			}

			if (eventType === "input_audio_buffer.speech_stopped") {
				applyPhase("thinking");
				return;
			}

			if (eventType === "response.output_item.added") {
				const item = (event as { item?: { type?: string; name?: string } })
					.item;
				if (item?.type === "function_call") {
					if (item.name === "wait_for_user") {
						// Model classified the input as background noise / silence.
						// Drop straight back to listening (still respect MIN_HOLD so
						// the bar doesn't blink).
						transitionWithHold("listening");
					} else {
						transitionWithHold("acting", {
							label: friendlyToolName(item.name ?? "Working"),
						});
					}
				}
				return;
			}

			if (eventType === "response.output_audio.delta") {
				if (phaseRef.current !== "speaking") {
					transitionWithHold("speaking");
				}
				return;
			}

			if (eventType === "response.done") {
				// Brief "Done" pulse, then back to listening. Skipped if the
				// user already started speaking (handled above) since that
				// path snaps to listening + cancels timers.
				transitionWithHold("done", { summary: "Done" });
				if (doneLingerRef.current) {
					clearTimeout(doneLingerRef.current);
				}
				doneLingerRef.current = setTimeout(() => {
					doneLingerRef.current = null;
					if (phaseRef.current === "done") {
						applyPhase("listening");
					}
				}, DONE_LINGER_MS);
				return;
			}

			if (eventType === "error") {
				const message =
					(event as { error?: { message?: string } }).error?.message ??
					"Realtime session error";
				applyPhase("done", { summary: message, tone: "error" });
				return;
			}
		};

		void startRealtimeVoiceSession()
			.then((next) => {
				if (cancelled) {
					next.stop();
					return;
				}
				session = next;
				setLocalStream(next.localStream);
				next.remoteStream
					.then((rs) => {
						if (!cancelled) setRemoteStream(rs);
					})
					.catch(() => {
						// Remote-track wiring failure is rare; the bar will
						// just stay at level=0 for the speaking phase, which
						// degrades gracefully.
					});
				// Wire the agent tool dispatcher first so it sees every
				// function-call delta before our UI handler reacts. Both
				// run for every event -- they're observers, not consumers.
				const dispatcher = createToolDispatcher({ send: next.send });
				next.onEvent((event) => dispatcher.handleEvent(event));
				next.onEvent(handleEvent);
			})
			.catch((err) => {
				if (cancelled) return;
				applyPhase("done", { summary: messageOf(err), tone: "error" });
			});

		return () => {
			cancelled = true;
			if (pendingTransitionRef.current) {
				clearTimeout(pendingTransitionRef.current);
				pendingTransitionRef.current = null;
			}
			if (doneLingerRef.current) {
				clearTimeout(doneLingerRef.current);
				doneLingerRef.current = null;
			}
			session?.stop();
			session = null;
			setLocalStream(null);
			setRemoteStream(null);
		};
	}, [active, applyPhase, transitionWithHold]);

	return useMemo(
		() => ({
			phase,
			level:
				phase === "listening" ? micLevel : phase === "speaking" ? ttsLevel : 0,
			label,
			summary,
			tone,
		}),
		[phase, micLevel, ttsLevel, label, summary, tone],
	);
}

/** snake_case_tool_name -> "Snake Case Tool Name". Best-effort; we don't
 *  have a curated label map yet, but at least the function name reads as
 *  English in the bar. */
function friendlyToolName(name: string): string {
	return name
		.replace(/_/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
}

/** Robust error-to-string. Tauri rejects with the JSON-shaped CommandError
 *  (`{ code, message }`) rather than an `Error` instance, so the plain
 *  `String(err)` falls back to "[object Object]". Walk a few likely
 *  shapes — including `{ message }` for our Rust IPC layer — and only
 *  fall through to `String()` for genuine string-ish primitives. */
function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (err && typeof err === "object") {
		const msg = (err as { message?: unknown }).message;
		if (typeof msg === "string" && msg.length > 0) return msg;
		try {
			return JSON.stringify(err);
		} catch {
			// fall through to String() below
		}
	}
	return String(err);
}
