import { useEffect, useMemo, useState } from "react";

/** Distinct phases the voice bar can be in. The status text + lucide icon
 *  pick up from `phase`; BorderBeam's `duration` / `strength` props derive
 *  their values from `phase` + `level`.
 *
 *  Four-state machine:
 *  - `connecting`: WebRTC + `session.created` handshake in flight. Bar
 *    is visible but speaking would be dropped, so visuals are mono +
 *    dim to signal "warming up".
 *  - `listening`: idle or user-speaking. Same visual either way — when
 *    the server's VAD fires we just refresh the level. Default state.
 *  - `acting`: model is running a typed function tool. Status text is
 *    a human-readable label per tool ("Creating workspace", ...).
 *  - `speaking`: model is producing audio. `label` carries the rolling
 *    transcript from `response.output_audio_transcript.delta` deltas,
 *    truncated to one line at the consumer.
 *
 *  There is no `thinking` or `done` phase by design: any gap between
 *  user-stop and model-start sits inside `listening`, and the natural
 *  decay back to `listening` after `response.done` replaces the old
 *  done-linger. */
export type VoiceUiPhase = "connecting" | "listening" | "acting" | "speaking";

export type VoiceUiState = {
	phase: VoiceUiPhase;
	/** Voice volume 0..1. Drives BorderBeam strength while the user (or
	 *  the agent's TTS) is speaking. 0 in non-audio phases. */
	level: number;
	/** Phase-dependent right-hand text:
	 *   - `acting`: human-readable tool status ("Creating workspace").
	 *   - `speaking`: rolling transcript of what the agent is saying.
	 *   - `listening` + `tone:"error"`: the error message.
	 *   - everything else: undefined → fall back to `DEFAULT_TEXT[phase]`. */
	label?: string;
	/** Visual tone override. `"error"` swaps the icon to AlertCircle and
	 *  recolors the row to a destructive accent without expanding the
	 *  phase enum. Applied on top of `listening` after a Realtime API
	 *  failure (mic denied, ephemeral key error, dataChannel error). */
	tone?: "error";
};

const IDLE_LEVEL = 0;

/** Minimum hold per phase. Even if a phase logically resolves in 1 ms (e.g.
 *  the agent calls a tool that returns instantly), we hold the visual on
 *  that phase for at least this long so transitions don't flash. */
const MIN_HOLD_MS: Partial<Record<VoiceUiPhase, number>> = {
	// Even on a warm cache + same-region OpenAI handshake the round-trip
	// is several hundred ms. Holding for 400 ms means a fast successful
	// connect still gets a brief "connecting" frame instead of flashing
	// straight to colorful — users perceive that as "it warmed up".
	connecting: 400,
	// Some CLI reads (list_workspaces, list_repos) come back in <100 ms.
	// Hold acting for the same beat so the tool status doesn't flicker
	// past — the user should at least register what the agent did.
	acting: 400,
};

export function getMinHold(phase: VoiceUiPhase): number {
	return MIN_HOLD_MS[phase] ?? 0;
}

/**
 * Scripted demo sequence. Re-runs every time `active` flips false -> true,
 * so collapsing the bar (⌘⇧V off) and reopening it (⌘⇧V on) replays the
 * whole arc -- which is what we want while iterating on the visuals
 * without a real backend / API key.
 *
 * Matches the new four-phase machine: connecting → listening (user
 * speaks) → acting (chained tool calls) → speaking (typewritten reply)
 * → listening. No thinking, no done.
 */
export function useDemoSequence(active: boolean): VoiceUiState {
	const [phase, setPhase] = useState<VoiceUiPhase>("listening");
	const [level, setLevel] = useState(IDLE_LEVEL);
	const [label, setLabel] = useState<string | undefined>();

	useEffect(() => {
		// When voice mode is off, park in "listening" so the next ON kicks
		// off from a clean baseline. The bar slot is height 0 anyway.
		if (!active) {
			setPhase("listening");
			setLevel(IDLE_LEVEL);
			setLabel(undefined);
			return;
		}

		const timeouts: ReturnType<typeof setTimeout>[] = [];
		let rafId: number | null = null;

		// Simulated voice-volume oscillator. Smooth low-frequency wobble +
		// jitter, clamped 0..1. Used for both user mic (listening) and TTS
		// output (speaking) since the demo has no real audio source.
		const startVolumeSim = (durationMs: number) => {
			const start = performance.now();
			const tick = () => {
				const elapsed = performance.now() - start;
				if (elapsed >= durationMs) {
					setLevel(IDLE_LEVEL);
					rafId = null;
					return;
				}
				const t = elapsed / 1000;
				const base = 0.5 + 0.32 * Math.sin(t * 6) + 0.12 * Math.sin(t * 13);
				const jitter = (Math.random() - 0.5) * 0.18;
				setLevel(Math.max(0, Math.min(1, base + jitter)));
				rafId = requestAnimationFrame(tick);
			};
			rafId = requestAnimationFrame(tick);
		};

		const stopVolumeSim = () => {
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			setLevel(IDLE_LEVEL);
		};

		// Pretend transcript that gets revealed character-by-character
		// during the speaking phase, so the demo shows the same typewriter
		// behaviour the real session produces from streaming deltas.
		const demoTranscript = "Three in progress, two done, one in review.";

		// Reset to clean "listening idle" baseline.
		setPhase("listening");
		setLabel(undefined);
		setLevel(IDLE_LEVEL);

		// Phase A: idle 1.2 s, then user "speaks" 3 s with simulated mic level.
		timeouts.push(setTimeout(() => startVolumeSim(3000), 1200));

		// Phase B: acting — three chained tool calls. No `thinking` gap.
		timeouts.push(
			setTimeout(() => {
				stopVolumeSim();
				setPhase("acting");
				setLabel("Creating workspace");
			}, 4200),
		);
		timeouts.push(setTimeout(() => setLabel("Listing repos"), 5500));
		timeouts.push(setTimeout(() => setLabel("Sending to agent"), 6800));

		// Phase C: speaking — typewriter reveal of demoTranscript over 2 s.
		timeouts.push(
			setTimeout(() => {
				setPhase("speaking");
				setLabel("");
				const stepMs = 2000 / demoTranscript.length;
				for (let i = 1; i <= demoTranscript.length; i++) {
					timeouts.push(
						setTimeout(() => setLabel(demoTranscript.slice(0, i)), i * stepMs),
					);
				}
				startVolumeSim(2400);
			}, 8200),
		);

		// Phase D: back to listening, ready for the next user turn. The
		// real session does the same via `response.done`.
		timeouts.push(
			setTimeout(() => {
				stopVolumeSim();
				setPhase("listening");
				setLabel(undefined);
			}, 11000),
		);

		return () => {
			for (const t of timeouts) clearTimeout(t);
			stopVolumeSim();
		};
	}, [active]);

	return useMemo(() => ({ phase, level, label }), [phase, level, label]);
}
