import { AlertCircle, Loader2, Mic, Volume2 } from "lucide-react";
import {
	type ComponentType,
	type CSSProperties,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/lib/utils";
import type { VoiceUiPhase, VoiceUiState } from "./voice-mode-state";

/** Phase → lucide icon. The lingering-transcript window inside the
 *  listening phase swaps the icon to Volume2 at the call-site below;
 *  the entry here is the *idle* listening visual. */
const ICONS: Record<
	VoiceUiPhase,
	ComponentType<{ className?: string; strokeWidth?: number }>
> = {
	connecting: Loader2,
	listening: Mic,
	acting: Loader2,
	speaking: Volume2,
};

const DEFAULT_TEXT: Record<VoiceUiPhase, string> = {
	connecting: "Connecting",
	listening: "Listening",
	acting: "Working",
	// Speaking's label is the streaming transcript; no default — when
	// the first delta hasn't landed yet the bar simply shows the icon.
	speaking: "",
};

/** Slide-up animation duration for scene transitions. Same easing as the
 *  composer height transition so the bar feels like one unit. */
const ANIM_MS = 280;
const ANIM_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

/** A scene is uniquely identified by phase + the dynamic content shown.
 *  When this string changes we slide a new layer in and slide the old one
 *  out; when it stays the same we just refresh the level / props on the
 *  current layer with no animation.
 *
 *  Speaking and the lingering-transcript window inside listening share
 *  the same scene key (`transcript`) so the transition between them
 *  doesn't slide — only the underlying BorderBeam mode + reactivity
 *  changes. Acting is keyed on its label so successive tool calls each
 *  slide in a fresh status line. Listening (idle) is its own scene so
 *  the lingering-transcript → "Listening" transition (after the 600 ms
 *  hold) gets a proper slide. Error is its own scene regardless of
 *  phase. */
function sceneKey(s: VoiceUiState): string {
	if (s.tone === "error") return `error:${s.label ?? ""}`;
	if (s.phase === "speaking" || (s.phase === "listening" && s.label)) {
		return "transcript";
	}
	if (s.phase === "acting") return `acting:${s.label ?? ""}`;
	return s.phase;
}

function Scene({
	state,
	className,
	style,
}: {
	state: VoiceUiState;
	className?: string;
	style?: CSSProperties;
}) {
	const isError = state.tone === "error";
	const phase = state.phase;
	// While listening, a non-empty label means the previous agent
	// reply's transcript is still on screen (held for 600 ms after
	// `response.done`). In that window the bar visually mirrors the
	// `speaking` scene — Volume2 + text — so the transition between
	// them is invisible. Once the hold expires, label clears and we
	// fall back to the idle Mic + "Listening" visual.
	const hasLingeringTranscript =
		phase === "listening" && !isError && !!state.label;

	const Icon = isError
		? AlertCircle
		: hasLingeringTranscript
			? Volume2
			: ICONS[phase];
	const label = isError
		? (state.label ?? "Voice session error")
		: hasLingeringTranscript
			? (state.label ?? "")
			: phase === "speaking"
				? (state.label ?? "")
				: phase === "acting" && state.label
					? state.label
					: DEFAULT_TEXT[phase];
	const spin = !isError && (phase === "acting" || phase === "connecting");

	return (
		<div
			className={cn("flex h-full w-full items-center gap-2", className)}
			style={style}
		>
			<Icon
				className={cn(
					"size-3.5 shrink-0",
					isError ? "text-destructive" : "text-foreground/70",
					spin && "animate-spin",
				)}
				strokeWidth={1.8}
			/>
			{/* `leading-none` so the text's line-box equals its font-size --
			    otherwise the default leading inflates the box vertically and
			    `items-center` centers the inflated box (looks low).
			    `max-w-[80%]` caps the label at 80% of the bar so long
			    transcripts truncate with `…` instead of pushing the bar
			    or hiding the icon. `min-w-0 + flex-1` keep short labels
			    left-aligned next to the icon. */}
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-[13px] leading-none tracking-tight",
					isError ? "text-destructive/90" : "text-foreground/85",
				)}
				title={label}
			>
				{label}
			</span>
		</div>
	);
}

/**
 * Status content for the voice bar -- icon + label + optional progress
 * chip, with a bottom-up slide animation when the scene changes. Only the
 * scene-defining fields (phase, label, summary) trigger the animation;
 * level changes (mic / TTS volume) flow straight through to BorderBeam
 * without remounting anything here.
 */
export function VoiceModeStatus({ state }: { state: VoiceUiState }) {
	const [pair, setPair] = useState<{
		current: VoiceUiState;
		previous: VoiceUiState | null;
	}>({ current: state, previous: null });
	const lastKeyRef = useRef(sceneKey(state));

	useEffect(() => {
		const key = sceneKey(state);
		if (key === lastKeyRef.current) {
			// Same scene -- refresh latest props (level etc.) without
			// kicking off another slide.
			setPair((p) => ({ ...p, current: state }));
			return;
		}
		lastKeyRef.current = key;
		setPair((p) => ({ current: state, previous: p.current }));
		const timer = setTimeout(
			() => setPair((p) => ({ ...p, previous: null })),
			ANIM_MS,
		);
		return () => clearTimeout(timer);
	}, [state]);

	return (
		<div className="relative h-full min-w-0 flex-1 overflow-hidden">
			{/* Keyframes are scoped via class names so they don't clash with
			    other inline-styled keyframes elsewhere in the app. */}
			<style>{`
				@keyframes voice-status-enter {
					from { transform: translateY(100%); opacity: 0; }
					to   { transform: translateY(0);    opacity: 1; }
				}
				@keyframes voice-status-exit {
					from { transform: translateY(0);     opacity: 1; }
					to   { transform: translateY(-100%); opacity: 0; }
				}
			`}</style>
			{pair.previous ? (
				<Scene
					key={`prev-${sceneKey(pair.previous)}`}
					state={pair.previous}
					className="absolute inset-0"
					style={{
						animation: `voice-status-exit ${ANIM_MS}ms ${ANIM_EASING} both`,
					}}
				/>
			) : null}
			<Scene
				key={`curr-${sceneKey(pair.current)}`}
				state={pair.current}
				className="absolute inset-0"
				style={{
					animation: `voice-status-enter ${ANIM_MS}ms ${ANIM_EASING} both`,
				}}
			/>
		</div>
	);
}
