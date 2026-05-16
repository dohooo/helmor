import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceDispatchActionKind } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	type RealtimeServerEvent,
	type RealtimeVoiceSession,
	startRealtimeVoiceSession,
} from "./realtime-session";
import {
	type AgentMutationKind,
	createToolDispatcher,
} from "./tool-dispatcher";
import { useAudioLevel } from "./use-audio-level";
import { voiceDiag } from "./voice-diag";
import {
	getMinHold,
	type VoiceUiPhase,
	type VoiceUiState,
} from "./voice-mode-state";
import { voiceModeStore } from "./voice-mode-store";

/** Tag UI state-machine events under the `sequence.` namespace. */
function diag(event: string, data?: Record<string, unknown>) {
	voiceDiag(`sequence.${event}`, data);
}

/** How long the just-finished transcript stays on screen as the bar's
 *  label after `response.done`. After this window expires we drop back
 *  to Mic + "Listening". Long enough to read a short-to-medium reply,
 *  short enough that the bar doesn't feel stuck if the user wants to
 *  jump back in. The linger timer is cancelled the moment the user
 *  starts speaking (`input_audio_buffer.speech_started`), so this is a
 *  soft upper bound — if the user is going to keep talking they don't
 *  pay the full wait. 2 seconds reads as "I have a beat to digest what
 *  it said", which felt rushed at 1 second. */
const TRANSCRIPT_LINGER_MS = 2000;

/**
 * Realtime API-driven counterpart to `useDemoSequence`. Same output
 * shape (`VoiceUiState`), but the phase comes from OpenAI Realtime
 * dataChannel events and `level` comes from a real AnalyserNode on the
 * user's mic / the model's TTS stream.
 *
 * # State machine
 *
 *   (hidden) ─active=true─► connecting ─session.created─► listening ◄──┐
 *                                                                       │
 *   listening ─output_item.added(function_call ≠ wait_for_user)─► acting│
 *   listening ─output_audio_transcript.delta─► speaking                 │
 *   listening ─output_audio.delta (no transcript yet)─► speaking        │
 *   acting    ─output_audio_transcript.delta─► speaking                 │
 *   acting    ─output_item.added(function_call)─► acting (label update) │
 *   speaking  ─output_audio_transcript.delta─► speaking (transcript++)  │
 *   speaking  ─speech_started─► listening (user barge-in)               │
 *   speaking  ─response.done─► listening ────────────────────────────────┘
 *   acting    ─response.done─► (no-op; either tool result is pending and
 *                               the next response will start speaking,
 *                               or another function_call updates label)
 *   (any)     ─speech_started─► listening (cancels pending transitions)
 *   (any)     ─error event─► listening + tone:"error" (sticky message)
 *
 * # Transcript accumulation
 *
 * The `speaking` phase carries the streaming transcript in `label`.
 * Deltas arrive as `response.output_audio_transcript.delta` and are
 * appended to a ref; the ref is the canonical buffer. When entering
 * speaking from a held-back transition (MIN_HOLD on acting), the label
 * is read from the ref *at fire time* so deltas accumulated during the
 * hold survive into the eventual speaking frame. The buffer resets on
 * every fresh speaking entry.
 *
 * # Hold semantics
 *
 * `connecting` and `acting` carry MIN_HOLD windows so quick handshakes
 * and quick CLI returns don't flash past visibly. Transitions inside
 * those windows are queued; transitions out of `speaking` are
 * immediate (the bar should mirror audible state). User barge-in
 * (`speech_started`) cancels any queued transition and snaps to
 * listening — a sticking visual would feel laggy when the user just
 * spoke.
 */
export function useRealtimeSequence(
	active: boolean,
	onNavigateToWorkspace?: (workspaceId: string) => void,
	onEndSession?: () => void,
	onDispatchWorkspaceAction?: (
		workspaceId: string,
		actionKind: VoiceDispatchActionKind,
	) => void,
): VoiceUiState {
	// Hold the latest navigation / end-session / dispatch callbacks in
	// refs. Caller-side identity can change every render (App.tsx's
	// `handleSelectWorkspace` closes over plenty of state), but we don't
	// want a fresh closure to retrigger the WebRTC session lifecycle —
	// that's exactly the bug this whole provider exists to fix. Reading
	// through refs keeps the latest behavior without dragging callback
	// identity into the effect dep array.
	const navigateRef = useRef(onNavigateToWorkspace);
	useEffect(() => {
		navigateRef.current = onNavigateToWorkspace;
	}, [onNavigateToWorkspace]);
	const endSessionRef = useRef(onEndSession);
	useEffect(() => {
		endSessionRef.current = onEndSession;
	}, [onEndSession]);
	const dispatchActionRef = useRef(onDispatchWorkspaceAction);
	useEffect(() => {
		dispatchActionRef.current = onDispatchWorkspaceAction;
	}, [onDispatchWorkspaceAction]);

	const [phase, setPhase] = useState<VoiceUiPhase>("listening");
	const [label, setLabel] = useState<string | undefined>();
	const [tone, setTone] = useState<"error" | undefined>();
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

	const micLevel = useAudioLevel(localStream);
	const ttsLevel = useAudioLevel(remoteStream);

	// Voice tools mutate the same SQLite the desktop app reads from.
	// Without explicit invalidation the running GUI never notices —
	// newly-created workspaces stay invisible until restart. Map the
	// dispatcher's coarse mutation kinds to the precise React Query
	// keys that drive the visible UI. The set of kinds is whatever the
	// Rust `MutationKind` enum emits (`workspaces` / `sessions` today;
	// add a branch for `repos` etc. as the enum grows).
	const queryClient = useQueryClient();
	const invalidateCaches = useCallback(
		(kinds: AgentMutationKind[]) => {
			const want = new Set(kinds);
			if (want.has("workspaces")) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				});
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.archivedWorkspaces,
				});
			}
			if (want.has("sessions")) {
				// `helmor send` can create a session inside any workspace
				// in the database; we don't know which without parsing
				// the response, so invalidate every workspaceSessions
				// query and let React Query refetch the visible ones.
				void queryClient.invalidateQueries({
					predicate: (query) => query.queryKey[0] === "workspaceSessions",
				});
			}
		},
		[queryClient],
	);

	// Refs hold "current" values for use inside async event handlers
	// without re-binding the handler every render.
	const phaseRef = useRef<VoiceUiPhase>("listening");
	const phaseStartRef = useRef(performance.now());
	const pendingTransitionRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	// Canonical buffer for the speaking-phase transcript. Lives outside
	// React state because deltas arrive rapidly (several per second)
	// and we want every append to land before the next render. The
	// `label` setter then publishes the current buffer to the UI.
	const transcriptBufferRef = useRef("");
	// After `response.done` we keep the just-spoken transcript on screen
	// for [`TRANSCRIPT_LINGER_MS`] before flipping the bar back to the
	// idle Mic + "Listening" visual. This timer drives that hold.
	// Cancelled by any event that overrides the lingering content
	// (speech_started, new tool call, fresh agent reply, error).
	const transcriptLingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	const applyPhase = useCallback(
		(
			next: VoiceUiPhase,
			opts: {
				label?: string;
				tone?: "error";
			} = {},
		) => {
			const prev = phaseRef.current;
			phaseRef.current = next;
			phaseStartRef.current = performance.now();
			setPhase(next);
			setLabel(opts.label);
			setTone(opts.tone);
			// Echo every phase application — this is the single chokepoint
			// for state transitions, so logging here covers all paths
			// (transitionWithHold, scheduleSpeakingTransition, the speech
			// barge-in path, the response.done fallbacks, error events).
			// Keep label truncated; transcripts can grow large and we have
			// the full string in `voice-state` echoes anyway.
			diag("phase", {
				from: prev,
				to: next,
				labelPreview: opts.label?.slice(0, 80) ?? null,
				tone: opts.tone ?? null,
			});
		},
		[],
	);

	/** Honor the current phase's MIN_HOLD before applying the next one.
	 *  Re-calling cancels any pending transition and queues a fresh one. */
	const transitionWithHold = useCallback(
		(next: VoiceUiPhase, opts: { label?: string; tone?: "error" } = {}) => {
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

	/** Speaking is special: its label is the live transcript buffer,
	 *  which keeps growing during the MIN_HOLD wait. So we read the
	 *  ref *at fire time*, not at schedule time. */
	const scheduleSpeakingTransition = useCallback(() => {
		if (pendingTransitionRef.current) {
			clearTimeout(pendingTransitionRef.current);
			pendingTransitionRef.current = null;
		}
		const elapsed = performance.now() - phaseStartRef.current;
		const minHold = getMinHold(phaseRef.current);
		const remaining = Math.max(0, minHold - elapsed);
		const fire = () => {
			pendingTransitionRef.current = null;
			applyPhase("speaking", { label: transcriptBufferRef.current });
		};
		if (remaining === 0) {
			fire();
		} else {
			pendingTransitionRef.current = setTimeout(fire, remaining);
		}
	}, [applyPhase]);

	useEffect(() => {
		const clearLingerTimer = () => {
			if (transcriptLingerTimerRef.current) {
				clearTimeout(transcriptLingerTimerRef.current);
				transcriptLingerTimerRef.current = null;
			}
		};

		if (!active) {
			// Reset to clean baseline when voice mode toggles off. Any
			// pending transition timer is cleared by the effect cleanup
			// below (this branch returns early before scheduling anything).
			diag("sequence-inactive");
			clearLingerTimer();
			transcriptBufferRef.current = "";
			applyPhase("listening");
			return;
		}

		// Immediately enter the warmup phase so the bar's first paint is
		// the muted mono BorderBeam rather than the colourful "ready"
		// state. We flip to `listening` once the server confirms the
		// session is live (see `session.created` handler below).
		diag("sequence-activate");
		clearLingerTimer();
		transcriptBufferRef.current = "";
		applyPhase("connecting");

		let cancelled = false;
		let session: RealtimeVoiceSession | null = null;

		const handleEvent = (event: RealtimeServerEvent) => {
			const eventType = event.type;
			if (!eventType) return;

			// ── Handshake done: leave warmup ─────────────────────────────
			if (eventType === "session.created" || eventType === "session.updated") {
				diag("server-session-ready", { eventType });
				if (phaseRef.current === "connecting") {
					transitionWithHold("listening");
				}
				return;
			}

			// ── User started speaking: snap to listening ─────────────────
			// This is also the safety net if the model is mid-response
			// and the user barges in: cancel any pending transition,
			// drop transcript, return to a clean listening visual. The
			// server itself cancels the response (interrupt_response=true).
			if (eventType === "input_audio_buffer.speech_started") {
				diag("user-speech-started", {
					phaseAtBarge: phaseRef.current,
					hadPendingTransition: pendingTransitionRef.current !== null,
					...sequenceDiagState(),
				});
				if (pendingTransitionRef.current) {
					clearTimeout(pendingTransitionRef.current);
					pendingTransitionRef.current = null;
				}
				clearLingerTimer();
				transcriptBufferRef.current = "";
				// Force a fresh listening apply: this both clears the
				// label (dropping any lingering transcript) and clears
				// the error tone, which would otherwise stick.
				applyPhase("listening");
				return;
			}

			// Less critical user-audio signals — but useful for
			// correlating "user spoke X seconds, then server fired Y" in
			// the trace. Kept on a separate diag event so transcript
			// readers can filter them out.
			if (eventType === "input_audio_buffer.speech_stopped") {
				diag("user-speech-stopped", sequenceDiagState());
				// Falls through to no-op; speaking phase doesn't change.
			}
			if (eventType === "input_audio_buffer.committed") {
				diag("user-audio-committed", sequenceDiagState());
			}

			// `speech_stopped` is intentionally a no-op for the bar's
			// phase — we stay in `listening` until the model emits its
			// first signal (a tool call or the first audio delta).

			// ── Model is calling a typed function tool ───────────────────
			if (eventType === "response.output_item.added") {
				const item = (event as { item?: { type?: string; name?: string } })
					.item;
				if (item?.type !== "function_call") return;
				const name = item.name;
				if (!name) return; // malformed; nothing we can show
				diag("server-function-call-added", {
					tool: name,
					...sequenceDiagState(),
				});
				if (name === "wait_for_user") {
					// No-op tool — model decided not to respond. Preserve any
					// lingering transcript from the previous reply so the
					// user doesn't lose context just because noise tripped
					// a no-op decision. Keep the linger timer running too.
					transitionWithHold("listening", {
						label: transcriptBufferRef.current || undefined,
					});
					return;
				}
				// An actual tool call starts a fresh turn — clear any
				// lingering transcript from the previous agent reply,
				// along with its hold timer.
				clearLingerTimer();
				transcriptBufferRef.current = "";
				transitionWithHold("acting", { label: humanToolStatus(name) });
				return;
			}

			// ── Model is speaking: accumulate transcript ─────────────────
			if (eventType === "response.output_audio_transcript.delta") {
				const delta = (event as { delta?: string }).delta ?? "";
				if (!delta) return;
				if (phaseRef.current === "speaking") {
					// Already in speaking — append directly and publish.
					transcriptBufferRef.current += delta;
					setLabel(transcriptBufferRef.current);
				} else {
					// First transcript chunk for a NEW agent reply.
					// Overwrite the buffer unconditionally — any prior
					// content is a lingering transcript from the previous
					// turn and must not be prefixed onto this one. Cancel
					// the linger timer in case we're inside the 600 ms
					// hold window.
					clearLingerTimer();
					transcriptBufferRef.current = delta;
					scheduleSpeakingTransition();
				}
				return;
			}

			// ── Audio without transcript: still triggers speaking ────────
			// (e.g. if user-side transcription is somehow disabled the
			// transcript stream might be empty, but audio is playing.)
			if (eventType === "response.output_audio.delta") {
				if (phaseRef.current !== "speaking") {
					// Same reasoning as the transcript branch: a new agent
					// reply has begun, so any lingering buffer is stale.
					clearLingerTimer();
					transcriptBufferRef.current = "";
					scheduleSpeakingTransition();
				}
				return;
			}

			// ── Response complete ────────────────────────────────────────
			// Transition out of `speaking` (normal case) or `acting` (the
			// fallback we added after observing a real-world stuck state).
			//
			// Acting-stuck case: the dispatcher submits a
			// `function_call_output` and a follow-up `response.create` so
			// the model can verbally acknowledge the tool result. *Usually*
			// that follow-up response streams audio/transcript, taking us
			// acting → speaking → listening. But if the follow-up response
			// finishes with `status=failed` or `cancelled` (server
			// rejection, user barge-in, empty completion), we never see a
			// transcript delta, so phase stays parked at `acting` with the
			// tool's "Creating + sending" label forever. Fall back to
			// listening; surface a friendly error if the server actually
			// failed so the user knows to retry instead of staring at a
			// frozen bar.
			//
			// Transcript-lingering: the just-spoken transcript persists
			// into the listening phase as the bar label for
			// `TRANSCRIPT_LINGER_MS`, giving the user time to read what
			// the agent said. After the timer fires we drop back to the
			// idle Mic + "Listening" visual; user/agent activity inside
			// the window cancels the timer (handled per event above).
			if (eventType === "response.done") {
				const responseAny = (event as { response?: unknown }).response as
					| {
							id?: string;
							status?: string;
							status_details?: {
								error?: { message?: string; code?: string; type?: string };
								reason?: string;
							};
					  }
					| undefined;
				const status = responseAny?.status;
				diag("response-done", {
					responseId: responseAny?.id ?? null,
					status: status ?? null,
					error:
						responseAny?.status_details?.error?.message ??
						responseAny?.status_details?.reason ??
						null,
					phaseAtDone: phaseRef.current,
					...sequenceDiagState(),
				});
				if (phaseRef.current === "speaking") {
					const transcript = transcriptBufferRef.current;
					applyPhase("listening", { label: transcript || undefined });
					clearLingerTimer();
					if (transcript) {
						transcriptLingerTimerRef.current = setTimeout(() => {
							transcriptLingerTimerRef.current = null;
							// Defensive: only auto-clear if we're still in the
							// lingering window. Any of the cancellation paths
							// above would have already cleared the buffer or
							// moved us to a different phase.
							if (
								phaseRef.current === "listening" &&
								transcriptBufferRef.current
							) {
								transcriptBufferRef.current = "";
								applyPhase("listening");
							}
						}, TRANSCRIPT_LINGER_MS);
					}
				} else if (phaseRef.current === "acting" && status !== "completed") {
					// Only `failed` / `cancelled` here. `completed` is the
					// normal tool-call flow — the response that just
					// completed contained our function_call output_item,
					// the dispatcher will now run the tool, send
					// `function_call_output` + `response.create`, and
					// the *follow-up* response will either stream audio
					// (handled by the speaking transition) or fail
					// (handled by this branch on its own response.done).
					// Touching `acting` on the first completed response
					// would erase the spinner before the tool even
					// finished — visible flicker.
					clearLingerTimer();
					transcriptBufferRef.current = "";
					if (status === "failed") {
						// Pull whichever reason string the server gave us. The
						// `response.status_details.error.message` path is the
						// one OpenAI populates today; fall back through a few
						// likely shapes so a payload-schema bump doesn't
						// silently swallow the cause.
						const message =
							responseAny?.status_details?.error?.message ??
							responseAny?.status_details?.reason ??
							"Response failed";
						applyPhase("listening", { label: message, tone: "error" });
					} else {
						// `cancelled` — user barge-in or dispatcher abort.
						// No error tone; the bar just needs unsticking so
						// the user can talk again.
						applyPhase("listening");
					}
				}
				return;
			}

			// ── Hard error from server ───────────────────────────────────
			if (eventType === "error") {
				const errorObj = (
					event as {
						error?: { message?: string; code?: string; type?: string };
					}
				).error;
				const message = errorObj?.message ?? "Realtime session error";
				diag("server-error-handled", {
					code: errorObj?.code ?? null,
					type: errorObj?.type ?? null,
					message,
				});
				clearLingerTimer();
				transcriptBufferRef.current = "";
				applyPhase("listening", { label: message, tone: "error" });
				return;
			}
		};

		void startRealtimeVoiceSession()
			.then((next) => {
				if (cancelled) {
					diag("session-discarded-after-cancel");
					next.stop();
					return;
				}
				diag("session-attached");
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
				const dispatcher = createToolDispatcher({
					send: next.send,
					onMutation: invalidateCaches,
					// Route through refs so the dispatcher always sees
					// the latest App-side handlers without forcing us
					// to put them into this effect's deps (which would
					// restart the session on every parent render).
					onNavigateToWorkspace: (workspaceId) => {
						navigateRef.current?.(workspaceId);
					},
					onEndSession: () => {
						endSessionRef.current?.();
					},
					onDispatchWorkspaceAction: (workspaceId, actionKind) => {
						dispatchActionRef.current?.(workspaceId, actionKind);
					},
				});
				next.onEvent((event) => dispatcher.handleEvent(event));
				next.onEvent(handleEvent);
				// Optimistic ready signal: by the time this `.then` runs,
				// `setRemoteDescription(answer)` has resolved — the WebRTC
				// handshake is finished. `session.created` will follow ~50–
				// 200 ms later over the data channel as the authoritative
				// "configured & ready" event, but visually we promote now
				// so the bar doesn't sit on "Connecting" with a hot mic
				// after the macOS indicator already lit. The server
				// buffers any inbound audio until the session is fully
				// up, so speaking a beat early is safe. The session.created
				// handler is still wired as a defensive fallback (no-op
				// if we've already left connecting).
				if (phaseRef.current === "connecting") {
					transitionWithHold("listening");
				}
			})
			.catch((err) => {
				if (cancelled) {
					diag("session-error-after-cancel", { error: messageOf(err) });
					return;
				}
				diag("session-start-failed", { error: messageOf(err) });
				applyPhase("listening", { label: messageOf(err), tone: "error" });
			});

		return () => {
			diag("sequence-cleanup");
			cancelled = true;
			if (pendingTransitionRef.current) {
				clearTimeout(pendingTransitionRef.current);
				pendingTransitionRef.current = null;
			}
			clearLingerTimer();
			transcriptBufferRef.current = "";
			session?.stop();
			session = null;
			setLocalStream(null);
			setRemoteStream(null);
		};
	}, [
		active,
		applyPhase,
		transitionWithHold,
		scheduleSpeakingTransition,
		invalidateCaches,
	]);

	return useMemo(
		() => ({
			phase,
			level:
				phase === "listening" ? micLevel : phase === "speaking" ? ttsLevel : 0,
			label,
			tone,
		}),
		[phase, micLevel, ttsLevel, label, tone],
	);
}

/** Map a Realtime function-tool name to a human-readable status string
 *  for the `acting` phase. Keep these short and in present-progressive
 *  — they sit next to a spinning loader so the user reads "Creating
 *  workspace" while the spinner says "in progress". Unknown tools fall
 *  back to a Title Case rendering of the function name so the bar is
 *  still informative when we add a new tool before updating this map.
 *
 *  Keep in sync with the `tools` array in `settings_commands.rs` and
 *  `TOOL_REGISTRY` in `tool-dispatcher.ts`. */
function humanToolStatus(name: string): string {
	switch (name) {
		case "list_workspaces":
			return "Listing workspaces";
		case "show_workspace":
			return "Looking up workspace";
		case "create_workspace":
			return "Creating workspace";
		case "create_workspace_and_send":
			return "Creating + sending";
		case "create_workspace_variants":
			return "Creating variants";
		case "set_workspace_status":
			return "Updating status";
		case "archive_workspace":
			return "Archiving workspace";
		case "permanently_delete_workspace":
			return "Deleting workspace";
		case "run_workspace_action":
			return "Running action";
		case "run_workspace_script":
			return "Running script";
		case "list_sessions":
			return "Listing sessions";
		case "get_session_messages":
			return "Reading session";
		case "send_prompt":
			return "Sending to agent";
		case "list_repos":
			return "Listing repos";
		case "list_context_items":
			return "Fetching contexts";
		case "get_context_item_detail":
			return "Reading context";
		case "capture_screen":
			return "Reading screen";
		default:
			return name
				.replace(/_/g, " ")
				.replace(/\b\w/g, (c) => c.toUpperCase())
				.trim();
	}
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

function sequenceDiagState(): Record<string, unknown> {
	return {
		mainSurfaceVisible: voiceModeStore.getMainSurfaceVisible(),
		documentHasFocus: document.hasFocus(),
		visibilityState: document.visibilityState,
	};
}
