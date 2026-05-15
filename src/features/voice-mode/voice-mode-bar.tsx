import type { CSSProperties } from "react";
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
	forceActive?: boolean;
};

const HELMOR_MARK_BLOCKS = [
	{
		key: "tl",
		d: "M162 306.673V80.582L375.51 193.625V419.709L162 306.673Z",
	},
	{
		key: "ml",
		d: "M376.057 454.357L162.553 341.314V567.399L376.057 680.442V454.357Z",
	},
	{
		key: "bl",
		d: "M162 828.14V602.047L375.51 715.089V941.174L162 828.14Z",
	},
	{
		key: "bridge",
		d: "M404.308 680.442V454.357L617.918 341.314V567.399L404.308 680.442Z",
	},
	{
		key: "br",
		d: "M646.615 828.14V602.047L860.126 715.089V941.174L646.615 828.14Z",
	},
	{
		key: "mr",
		d: "M860.667 454.357L647.165 341.314V567.399L860.667 680.442V454.357Z",
	},
	{
		key: "tr",
		d: "M646.615 306.673V80.582L860.126 193.625V419.709L646.615 306.673Z",
	},
] as const;

const ENDCAP_BEAM_BASE_STRENGTH = 0.25;
const ENDCAP_BEAM_LEVEL_HEADROOM = 1.5;

function VoiceModeStyles() {
	return (
		<style>{`
			@keyframes voice-mark-orbit {
				0%, 30% { transform: rotate(0deg); }
				65%, 100% { transform: rotate(360deg); }
			}
			@keyframes voice-mark-scatter {
				0%, 12% { transform: translate(0, 0); }
				30%, 65% { transform: translate(var(--voice-mark-x, 0), var(--voice-mark-y, 0)); }
				83%, 100% { transform: translate(0, 0); }
			}
			.voice-mark-block-1 { fill: oklch(0.82 0.18 25); --voice-mark-x: -19px; --voice-mark-y: 44px; animation-delay: 0ms; }
			.voice-mark-block-2 { fill: oklch(0.82 0.18 75); --voice-mark-x: -77px; --voice-mark-y: 67px; animation-delay: 70ms; }
			.voice-mark-block-3 { fill: oklch(0.82 0.18 145); --voice-mark-x: 85px; --voice-mark-y: 39px; animation-delay: 140ms; }
			.voice-mark-block-4 { fill: oklch(0.82 0.18 200); --voice-mark-x: 1px; --voice-mark-y: -300px; animation-delay: 210ms; }
			.voice-mark-block-5 { fill: oklch(0.82 0.18 255); --voice-mark-x: 21px; --voice-mark-y: 44px; animation-delay: 280ms; }
			.voice-mark-block-6 { fill: oklch(0.82 0.18 305); --voice-mark-x: 79px; --voice-mark-y: 67px; animation-delay: 350ms; }
			.voice-mark-block-7 { fill: oklch(0.82 0.18 355); --voice-mark-x: -83px; --voice-mark-y: 39px; animation-delay: 420ms; }
			@media (prefers-reduced-motion: reduce) {
				[data-voice-mark] * {
					animation-duration: 0.01ms !important;
					animation-iteration-count: 1 !important;
				}
			}
		`}</style>
	);
}

function deriveEndcapBeamStrength(state: VoiceUiState): number {
	if (state.phase !== "listening") {
		return ENDCAP_BEAM_BASE_STRENGTH;
	}

	return Math.min(
		1,
		ENDCAP_BEAM_BASE_STRENGTH + state.level * ENDCAP_BEAM_LEVEL_HEADROOM,
	);
}

function VoiceModeEndcap({ state }: { state: VoiceUiState }) {
	const loading = state.phase === "connecting" || state.phase === "acting";
	const error = state.tone === "error";
	const strength = deriveEndcapBeamStrength(state);

	return (
		<BorderBeam
			className="relative z-10 size-7 shrink-0"
			colorVariant="colorful"
			duration={2}
			size="sm"
			strength={strength}
		>
			<div
				className={cn(
					"relative flex size-7 items-center justify-center overflow-hidden rounded-[14px]",
					"bg-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--foreground)_7%,transparent),inset_0_0_6px_color-mix(in_oklch,black_42%,transparent)]",
					error && "bg-destructive/15",
				)}
				data-voice-endcap=""
			>
				<svg
					aria-hidden="true"
					className={cn(
						"relative z-10 size-4 overflow-visible",
						state.phase === "connecting" && "saturate-[0.4] brightness-75",
					)}
					data-voice-mark=""
					viewBox="0 0 1024 1024"
				>
					<g
						className={cn(
							"[transform-box:view-box] [transform-origin:512px_511px]",
							loading &&
								"[animation:voice-mark-orbit_var(--voice-mark-duration,8s)_ease-in-out_infinite]",
						)}
					>
						{HELMOR_MARK_BLOCKS.map((block, index) => (
							<path
								className={cn(
									`voice-mark-block-${index + 1}`,
									"[transform-box:view-box]",
									loading &&
										"[animation:voice-mark-scatter_var(--voice-mark-duration,8s)_ease-in-out_infinite]",
									error && "fill-destructive",
								)}
								d={block.d}
								key={block.key}
							/>
						))}
					</g>
				</svg>
			</div>
		</BorderBeam>
	);
}

function deriveVoiceBarStyle(state: VoiceUiState): CSSProperties {
	return {
		"--voice-mark-duration":
			state.phase === "connecting"
				? "14s"
				: state.phase === "acting"
					? "3.5s"
					: "8s",
	} as CSSProperties;
}

/**
 * Voice-mode bar slot. The visible bar is a static pill; motion is
 * concentrated in the left endcap around the Helmor mark.
 *
 * The bar is a passive consumer: state comes from `VoiceSessionProvider`
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
	forceActive,
}: VoiceModeBarProps) {
	const storeActive = useVoiceModeActive();
	const active = forceActive ?? storeActive;
	const state = useVoiceSession();
	const style = deriveVoiceBarStyle(state);

	return (
		<>
			<VoiceModeStyles />
			<div
				className="transition-[height,padding-top] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
				data-voice-active={active ? "" : undefined}
				data-voice-bar=""
				style={{
					height: active ? `${height}px` : "0px",
					paddingTop: active ? `${gap}px` : "0px",
					overflow: "hidden",
				}}
			>
				<div
					className={cn(
						"relative flex h-full w-full items-center gap-2 overflow-visible rounded-full border border-border bg-muted/30 py-0.5 pl-0.5 pr-3 transition-opacity duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
						className,
					)}
					style={{ ...style, opacity: active ? 1 : 0 }}
				>
					<VoiceModeEndcap state={state} />
					<VoiceModeStatus state={state} />
				</div>
			</div>
		</>
	);
}
