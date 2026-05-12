import type { BorderBeamColorVariant } from "@/components/border-beam";
import { BorderBeam } from "@/components/border-beam";
import { cn } from "@/lib/utils";
import type { VoiceUiState } from "./voice-mode-state";
import { VoiceModeStatus } from "./voice-mode-status";
import { useVoiceModeActive } from "./voice-mode-store";
import { useVoiceSession } from "./voice-session-provider";

type VoiceModeBarProps = {
	/** Total slot height (visible bar + top gap) when voice mode is active.
	 *  Should match the composer's `VOICE_SHRINK_PX` so the outer flex
	 *  column's total height stays constant. */
	height?: number;
	/** Vertical breathing room between the composer's bottom edge and the
	 *  visible bar. Carved out of the slot via `padding-top` so the bar's
	 *  visual height is `height - gap` (default 40 - 8 = 32 px). */
	gap?: number;
	className?: string;
};

/** Slow-flow base duration (seconds). Used for listening / speaking. */
const BEAM_SLOW_DURATION = 3;
/** Fast-flow duration when the agent is busy (acting). */
const BEAM_FAST_DURATION = 1.2;
/** Extra-slow drift during the warmup phase — meant to read as "idle" /
 *  "waiting", not "active". Keeps the bar present but un-distracting. */
const BEAM_CONNECTING_DURATION = 5;
/** Strength floor at idle / working states. Visible but restrained. */
const BEAM_BASE_STRENGTH = 0.3;
/** Strength while warming up. Much dimmer than the live floor so it's
 *  clearly subordinate to the "ready" state when they transition. */
const BEAM_CONNECTING_STRENGTH = 0.15;
/** Headroom above the floor that the audio level can push strength into. */
const BEAM_LEVEL_HEADROOM = 0.7;

function deriveBeamProps(state: VoiceUiState): {
	duration: number;
	strength: number;
	colorVariant: BorderBeamColorVariant;
} {
	// During warmup the session isn't actually receiving audio yet, so
	// we drop colour + reactivity and run a slow mono drift. The full
	// `colorful` palette only lights up once `session.created` lands.
	if (state.phase === "connecting") {
		return {
			duration: BEAM_CONNECTING_DURATION,
			strength: BEAM_CONNECTING_STRENGTH,
			colorVariant: "mono",
		};
	}
	// Acting (tool call running) is the only "busy" phase now — fast
	// loop, fixed strength, no level reactivity. Listening and speaking
	// both ride the audio level (mic and TTS respectively).
	const isWorking = state.phase === "acting";
	const reactive = state.phase === "listening" || state.phase === "speaking";
	return {
		duration: isWorking ? BEAM_FAST_DURATION : BEAM_SLOW_DURATION,
		strength: reactive
			? BEAM_BASE_STRENGTH + state.level * BEAM_LEVEL_HEADROOM
			: BEAM_BASE_STRENGTH,
		colorVariant: "colorful",
	};
}

/**
 * Voice-mode bar slot. Outer occupies `height` px when voice is active (0
 * otherwise) with a `gap`-px top padding so the visible bar sits below
 * the composer.
 *
 * Visual state is concentrated on the BorderBeam: `duration` controls
 * flow speed (slow at idle / speaking, fast while the agent is working);
 * `strength` controls intensity (low floor + audio-level headroom while
 * the user or TTS is speaking).
 *
 * The status content (icon + text) is a thin overlay -- lucide icons and
 * text that slides up between scenes.
 *
 * The bar is now a passive consumer: state comes from `VoiceSessionProvider`
 * (mounted near the top of the app tree), which owns the WebRTC peer and
 * the demo fallback. That makes the bar safe to mount in two mutually-
 * exclusive subtrees (the `workspaceViewMode === "start"` vs
 * `"conversation"` branches in `App.tsx`) without restarting the session
 * every time the user switches between them.
 */
export function VoiceModeBar({
	height = 40,
	gap = 8,
	className,
}: VoiceModeBarProps) {
	const active = useVoiceModeActive();
	const state = useVoiceSession();
	const beam = deriveBeamProps(state);

	return (
		<div
			className="transition-[height,padding-top] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
			data-voice-bar=""
			data-voice-active={active ? "" : undefined}
			style={{
				height: active ? `${height}px` : "0px",
				paddingTop: active ? `${gap}px` : "0px",
				// Slot-level overflow hidden so the bar's visible content
				// disappears when voice mode is off (height: 0). Note: this
				// also clips the BorderBeam's bloom that paints just outside
				// the bar's border -- if the bloom needs to spill, lift the
				// hidden onto a wrapping element with extra padding instead.
				overflow: "hidden",
			}}
		>
			<BorderBeam
				className="block h-full w-full"
				size="md"
				colorVariant={beam.colorVariant}
				duration={beam.duration}
				strength={beam.strength}
			>
				<div
					className={cn(
						"h-full w-full rounded-md border border-border bg-muted/30 transition-opacity duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
						className,
					)}
					style={{ opacity: active ? 1 : 0 }}
				>
					<VoiceModeStatus state={state} />
				</div>
			</BorderBeam>
		</div>
	);
}
