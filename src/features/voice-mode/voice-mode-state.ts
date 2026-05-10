import { useEffect, useMemo, useState } from "react";

/** Distinct phases the voice bar can be in. The status text + lucide icon
 *  pick up from `phase`; BorderBeam's `duration` / `strength` props derive
 *  their values from `phase` + `level`. */
export type VoiceUiPhase =
	| "listening"
	| "thinking"
	| "acting"
	| "speaking"
	| "done";

export type VoiceUiState = {
	phase: VoiceUiPhase;
	/** Voice volume 0..1. Drives BorderBeam strength while the user (or
	 *  the agent's TTS) is speaking. 0 in non-audio phases. */
	level: number;
	/** Action label shown while phase === "acting". */
	label?: string;
	/** Free-text shown while phase === "done". */
	summary?: string;
	/** Visual tone override. `"error"` swaps the icon to AlertCircle and
	 *  recolors the row to a destructive accent without expanding the
	 *  phase enum. Currently only set on `done` after a Realtime API
	 *  failure (mic denied, ephemeral key error, dataChannel error). */
	tone?: "error";
};

const IDLE_LEVEL = 0;

/** Minimum hold per phase. Even if a phase logically resolves in 1 ms (e.g.
 *  the agent thinks instantly), we hold the visual on that phase for at
 *  least this long so transitions don't flash. */
const MIN_HOLD_MS: Partial<Record<VoiceUiPhase, number>> = {
	thinking: 700,
};

export function getMinHold(phase: VoiceUiPhase): number {
	return MIN_HOLD_MS[phase] ?? 0;
}

/**
 * Scripted demo sequence. Re-runs every time `active` flips false -> true,
 * so collapsing the bar (⌘⇧V off) and reopening it (⌘⇧V on) replays the
 * whole arc -- which is what we want while iterating on the visuals
 * without a real backend.
 *
 * Once the OpenAI Realtime session lands, this hook gets replaced by a
 * real reducer driven by SDK events; the public shape stays the same.
 */
export function useDemoSequence(active: boolean): VoiceUiState {
	const [phase, setPhase] = useState<VoiceUiPhase>("listening");
	const [level, setLevel] = useState(IDLE_LEVEL);
	const [meta, setMeta] = useState<{
		label?: string;
		summary?: string;
	}>({});

	useEffect(() => {
		// When voice mode is off, park in "listening" so the next ON kicks
		// off from a clean baseline. The bar slot is height 0 anyway.
		if (!active) {
			setPhase("listening");
			setLevel(IDLE_LEVEL);
			setMeta({});
			return;
		}

		const timeouts: ReturnType<typeof setTimeout>[] = [];
		let rafId: number | null = null;

		// Simulated voice-volume oscillator. Smooth low-frequency wobble +
		// jitter, clamped 0..1. Used for both user mic (listening) and TTS
		// output (speaking) until real audio is wired in.
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

		// Reset to clean "listening idle" baseline.
		setPhase("listening");
		setMeta({});
		setLevel(IDLE_LEVEL);

		// Phase 1: listening idle (1.2 s of slow flow + low strength).
		// Phase 2: user "speaks" (3 s of strength wobble).
		timeouts.push(
			setTimeout(() => {
				startVolumeSim(3000);
			}, 1200),
		);

		// Phase 3: thinking (>= MIN_HOLD).
		timeouts.push(
			setTimeout(() => {
				stopVolumeSim();
				setPhase("thinking");
				setMeta({});
			}, 4200),
		);

		// Phase 4: acting -- three sequential tool calls.
		timeouts.push(
			setTimeout(() => {
				setPhase("acting");
				setMeta({ label: 'Creating workspace "Helmer Voice"' });
			}, 5200),
		);
		timeouts.push(
			setTimeout(() => {
				setMeta({ label: "Indexing files in repo" });
			}, 6500),
		);
		timeouts.push(
			setTimeout(() => {
				setMeta({ label: 'Opening branch "voice/sidebar"' });
			}, 7800),
		);

		// Phase 5: speaking -- TTS reply, level wobbles again.
		timeouts.push(
			setTimeout(() => {
				setPhase("speaking");
				setMeta({});
				startVolumeSim(2500);
			}, 9200),
		);

		// Phase 6: done -- short summary, stays until next toggle.
		timeouts.push(
			setTimeout(() => {
				stopVolumeSim();
				setPhase("done");
				setMeta({ summary: "3 workspaces · 4 actions" });
			}, 11800),
		);

		return () => {
			for (const t of timeouts) clearTimeout(t);
			stopVolumeSim();
		};
	}, [active]);

	return useMemo(() => ({ phase, level, ...meta }), [phase, level, meta]);
}
