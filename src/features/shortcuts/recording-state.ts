let activeRecordingCount = 0;

export function beginShortcutRecording() {
	activeRecordingCount += 1;
}

export function endShortcutRecording() {
	activeRecordingCount = Math.max(0, activeRecordingCount - 1);
}

export function isShortcutRecordingActive() {
	return activeRecordingCount > 0;
}
