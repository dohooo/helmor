import type { NotificationSound } from "@/lib/settings";

/// Plays a short sound effect alongside each desktop notification.
/// Files are served as static assets from `public/sounds/`. Missing
/// files are tolerated — `Audio.play()` rejects, we warn, and the
/// notification still goes through.

type PlayableSound = Exclude<NotificationSound, "off">;

const SOUND_FILES: Record<PlayableSound, string> = {
	ding: "/sounds/ding.ogg",
	pop: "/sounds/pop.ogg",
	chime: "/sounds/chime.ogg",
	glass: "/sounds/glass.ogg",
	soft: "/sounds/soft.ogg",
	positive: "/sounds/positive.ogg",
	doorbell: "/sounds/doorbell.ogg",
	scifi: "/sounds/scifi.ogg",
	bubble: "/sounds/bubble.ogg",
	confirm: "/sounds/confirm.ogg",
	elevator: "/sounds/elevator.ogg",
	blip: "/sounds/blip.ogg",
};

/** Human-readable labels for UI pickers. Kept here so the picker
 *  and the sound table can't drift apart. */
export const NOTIFICATION_SOUND_LABELS: Record<NotificationSound, string> = {
	off: "Off",
	ding: "Ding",
	pop: "Pop",
	chime: "Chime",
	glass: "Glass",
	soft: "Soft",
	positive: "Positive",
	doorbell: "Doorbell",
	scifi: "Sci-fi",
	bubble: "Bubble",
	confirm: "Confirm",
	elevator: "Elevator",
	blip: "Blip",
};

const audioCache = new Map<PlayableSound, HTMLAudioElement>();

function getAudio(sound: PlayableSound): HTMLAudioElement | null {
	if (typeof Audio === "undefined") return null;
	let audio = audioCache.get(sound);
	if (!audio) {
		audio = new Audio(SOUND_FILES[sound]);
		audio.preload = "auto";
		audioCache.set(sound, audio);
	}
	return audio;
}

export function playNotificationSound(sound: NotificationSound): void {
	if (sound === "off") return;
	const audio = getAudio(sound);
	if (!audio) return;
	// Rewind so rapid-fire notifications retrigger instead of being ignored.
	audio.currentTime = 0;
	void audio.play().catch((err) => {
		console.warn(`[notification-sound] failed to play "${sound}":`, err);
	});
}
