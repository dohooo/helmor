import { Brain, Check, Loader2, Mic, Volume2 } from "lucide-react";
import {
	type ComponentType,
	type CSSProperties,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/lib/utils";
import type { VoiceUiPhase, VoiceUiState } from "./voice-mode-state";

const ICONS: Record<
	VoiceUiPhase,
	ComponentType<{ className?: string; strokeWidth?: number }>
> = {
	listening: Mic,
	thinking: Brain,
	acting: Loader2,
	speaking: Volume2,
	done: Check,
};

const DEFAULT_TEXT: Record<VoiceUiPhase, string> = {
	listening: "Listening",
	thinking: "Thinking",
	acting: "Working",
	speaking: "Speaking",
	done: "Done",
};

/** Slide-up animation duration for scene transitions. Same easing as the
 *  composer height transition so the bar feels like one unit. */
const ANIM_MS = 280;
const ANIM_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

/** A scene is uniquely identified by phase + the dynamic content shown.
 *  When this string changes we slide a new layer in and slide the old one
 *  out; when it stays the same we just refresh the level / props on the
 *  current layer with no animation. */
function sceneKey(s: VoiceUiState): string {
	if (s.phase === "acting") return `acting:${s.label ?? ""}`;
	if (s.phase === "done") return `done:${s.summary ?? ""}`;
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
	const Icon = ICONS[state.phase];
	const label =
		state.phase === "acting" && state.label
			? state.label
			: state.phase === "done" && state.summary
				? state.summary
				: DEFAULT_TEXT[state.phase];
	const spin = state.phase === "acting";

	return (
		<div
			className={cn("flex h-full w-full items-center gap-2 px-3", className)}
			style={style}
		>
			<Icon
				className={cn(
					"size-3.5 shrink-0 text-foreground/70",
					spin && "animate-spin",
				)}
				strokeWidth={1.8}
			/>
			{/* `leading-none` so the text's line-box equals its font-size --
			    otherwise the default leading inflates the box vertically and
			    `items-center` centers the inflated box (looks low). `flex-1
			    min-w-0` lets the label fill the slack between icon and the
			    progress chip while still respecting `truncate`. */}
			<span className="min-w-0 flex-1 truncate text-[12px] leading-none tracking-tight text-foreground/85">
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
		<div className="relative h-full w-full overflow-hidden">
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
