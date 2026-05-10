import { useEffect, useState } from "react";

/**
 * Subscribe to a media stream's audio level (RMS, 0..1). Drives the
 * BorderBeam strength while the user or the assistant is speaking.
 *
 * Internals: spins up an `AudioContext` + `AnalyserNode` from the stream,
 * polls `getByteTimeDomainData` on every animation frame, computes RMS,
 * applies a soft curve so quiet speech still nudges the visual (raw RMS
 * for normal conversation hovers at ~0.05-0.2). Returns the smoothed
 * 0..1 level.
 *
 * Pass `null` to disable -- the hook cleans up its AudioContext and
 * settles at 0.
 */
export function useAudioLevel(stream: MediaStream | null | undefined): number {
	const [level, setLevel] = useState(0);

	useEffect(() => {
		if (!stream) {
			setLevel(0);
			return;
		}

		// Some browsers gate AudioContext on a user gesture. The voice
		// toggle shortcut IS a user gesture, so this should always be in a
		// resumed state, but we still call `resume()` defensively.
		const AudioContextCtor =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;
		if (!AudioContextCtor) {
			setLevel(0);
			return;
		}
		const audioCtx = new AudioContextCtor();
		void audioCtx.resume().catch(() => {
			// best effort; if it fails we still read zeros, which is
			// indistinguishable from "no audio" -- fine.
		});

		const source = audioCtx.createMediaStreamSource(stream);
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 256;
		analyser.smoothingTimeConstant = 0.5;
		source.connect(analyser);
		const buffer = new Uint8Array(analyser.frequencyBinCount);

		let rafId: number | null = null;
		let cancelled = false;

		const tick = () => {
			if (cancelled) return;
			analyser.getByteTimeDomainData(buffer);
			let sumSquares = 0;
			for (let i = 0; i < buffer.length; i++) {
				const sample = (buffer[i] - 128) / 128; // -1..1
				sumSquares += sample * sample;
			}
			const rms = Math.sqrt(sumSquares / buffer.length); // 0..1
			// Speech RMS ranges roughly 0.02 (whisper) -> 0.3 (loud). Scale
			// so a normal voice produces a visible level around 0.5-0.8.
			const curved = Math.min(1, rms * 3.2);
			setLevel(curved);
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);

		return () => {
			cancelled = true;
			if (rafId != null) {
				cancelAnimationFrame(rafId);
			}
			try {
				source.disconnect();
			} catch {
				// disconnect can throw if already disconnected; harmless.
			}
			void audioCtx.close().catch(() => {});
			setLevel(0);
		};
	}, [stream]);

	return level;
}
