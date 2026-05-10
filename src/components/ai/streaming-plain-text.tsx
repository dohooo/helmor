import { type CSSProperties, memo } from "react";
import { useSmoothStreamContent } from "@/features/conversation/hooks/use-smooth-stream-content";
import { cn } from "@/lib/utils";

// Plain-text reasoning renderer. The smoothing buffer alone gives the
// "soft typewriter" feel — we deliberately do NOT layer any fade animation
// on top: per-char spans cause kerning to re-shape when chars settle, and
// container-level CSS masks visibly dim the bottom of the last line.
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
	const smoothed = useSmoothStreamContent(children, { enabled: streaming });

	return (
		<div
			className={cn("whitespace-pre-wrap break-words", className)}
			style={style}
		>
			{smoothed}
		</div>
	);
});

StreamingPlainText.displayName = "StreamingPlainText";
