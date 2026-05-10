import { type CSSProperties, memo, useMemo } from "react";
import { STREAMING_SMOOTHING_PRESET } from "@/components/ai/streaming-animated";
import { useSmoothStreamContent } from "@/features/conversation/hooks/use-smooth-stream-content";
import { cn } from "@/lib/utils";

/**
 * Streamed plain-text renderer with character-level fade-in.
 *
 * Mirrors the typewriter look of <LazyStreamdown animated.sep="char"/> but
 * without the markdown pipeline — used for content that the model emits as
 * pure prose (reasoning blocks). Each character mounts inside its own
 * `<span class="stream-char">`, which CSS fades in. When `streaming` is
 * false we collapse to a single text node, so historical / static reads
 * pay nothing.
 */
export const StreamingPlainText = memo(function StreamingPlainText({
	children,
	streaming,
	className,
	style,
}: {
	children: string;
	streaming: boolean;
	className?: string;
	style?: CSSProperties;
}) {
	const smoothed = useSmoothStreamContent(children, {
		enabled: streaming,
		preset: STREAMING_SMOOTHING_PRESET,
	});

	// `[...str]` splits by codepoint so emoji / surrogate pairs stay intact.
	const chars = useMemo(
		() => (streaming ? [...smoothed] : null),
		[streaming, smoothed],
	);

	if (!streaming || chars === null) {
		return (
			<div
				className={cn("whitespace-pre-wrap break-words", className)}
				style={style}
			>
				{smoothed}
			</div>
		);
	}

	return (
		<div
			className={cn("whitespace-pre-wrap break-words", className)}
			style={style}
		>
			{/* index keys are intentional — `chars` only grows, never reorders */}
			{chars.map((c, i) => (
				<span key={i} className="stream-char">
					{c}
				</span>
			))}
		</div>
	);
});

StreamingPlainText.displayName = "StreamingPlainText";
