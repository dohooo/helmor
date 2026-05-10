// Streamdown char-level fade config; keep `duration` in sync with
// `.stream-char` in App.css so markdown and plain-text surfaces match.
export const STREAMING_ANIMATED = {
	animation: "fadeIn" as const,
	duration: 300,
	easing: "linear" as const,
	sep: "char" as const,
	stagger: 0,
};

// Smoothing preset shared by AssistantText and StreamingPlainText.
export const STREAMING_SMOOTHING_PRESET = "silky" as const;
