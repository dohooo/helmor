// Streamdown char-level fade config. `duration` here is mostly informational
// — the actual fade timing comes from the `[data-sd-animate]` override in
// App.css, which ignores streamdown's per-frame `--sd-duration` rewrite
// (that rewrite truncates in-flight fades to 0ms; see the App.css comment).
export const STREAMING_ANIMATED = {
	animation: "fadeIn" as const,
	duration: 300,
	easing: "linear" as const,
	sep: "char" as const,
	stagger: 0,
};

// Smoothing preset shared by AssistantText and StreamingPlainText.
export const STREAMING_SMOOTHING_PRESET = "silky" as const;
