/**
 * Shared `animated` config passed to `<LazyStreamdown>` for live streams.
 *
 * `sep: "char"` reveals one character at a time (vs. "word"), giving the
 * smoother typewriter feel; `stagger` is the per-unit fade offset in ms.
 * Tune `duration` to match `.stream-char` in App.css so the markdown
 * surface (AssistantText) and the plain-text surface (ReasoningContent)
 * feel uniform.
 */
export const STREAMING_ANIMATED = {
	animation: "fadeIn" as const,
	duration: 300,
	easing: "linear" as const,
	sep: "char" as const,
	stagger: 0,
};

/**
 * Shared smoothing preset for both AssistantText and StreamingPlainText.
 * `silky` defaults to ~28 cps (vs. balanced's 38) and a longer settling
 * window — slower, more deliberate typewriter cadence.
 */
export const STREAMING_SMOOTHING_PRESET = "silky" as const;
