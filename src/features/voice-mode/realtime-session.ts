import { createOpenAiRealtimeClientSecret } from "@/lib/api";

/** Minimal shape of a server-pushed Realtime event. We only narrow the
 *  `type` discriminator -- everything else stays `unknown` so the consumer
 *  can pattern-match without us copying the full event schema. */
export type RealtimeServerEvent = {
	type?: string;
	[key: string]: unknown;
};

type EventListener = (event: RealtimeServerEvent) => void;

export type RealtimeVoiceSession = {
	/** Tear down peer + mic + speaker + close audio context. Idempotent. */
	stop: () => void;
	/** Subscribe to dataChannel events. Returns an unsubscribe. Listeners
	 *  registered before the WebRTC handshake completes still get every
	 *  event (including `session.created`) because the listener fan-out
	 *  is wired before `setLocalDescription`. */
	onEvent: (listener: EventListener) => () => void;
	/** User's microphone stream. Stable for the whole session lifetime --
	 *  safe to feed straight to an `AnalyserNode`. */
	localStream: MediaStream;
	/** OpenAI's TTS stream. Resolves the first time `ontrack` fires. */
	remoteStream: Promise<MediaStream>;
};

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export async function startRealtimeVoiceSession(): Promise<RealtimeVoiceSession> {
	if (!navigator.mediaDevices?.getUserMedia) {
		throw new Error(
			"Microphone capture is unavailable in this Tauri WebView. Restart Helmor and try again.",
		);
	}

	const clientSecret = await createOpenAiRealtimeClientSecret();
	const stream = await getMicrophoneStream();
	const peer = new RTCPeerConnection();
	const audio = new Audio();
	const dataChannel = peer.createDataChannel("oai-events");

	audio.autoplay = true;

	let resolveRemote!: (s: MediaStream) => void;
	const remoteStream = new Promise<MediaStream>((resolve) => {
		resolveRemote = resolve;
	});

	peer.ontrack = (event) => {
		const [remote] = event.streams;
		if (remote) {
			audio.srcObject = remote;
			resolveRemote(remote);
		}
	};

	for (const track of stream.getTracks()) {
		peer.addTrack(track, stream);
	}

	const listeners = new Set<EventListener>();
	dataChannel.addEventListener("message", (event) => {
		let payload: RealtimeServerEvent;
		try {
			payload = JSON.parse(String(event.data)) as RealtimeServerEvent;
		} catch {
			// Non-JSON control messages -- ignore.
			return;
		}
		if (payload.type === "error") {
			console.error("[helmor] OpenAI Realtime error", payload);
		}
		for (const listener of listeners) {
			listener(payload);
		}
	});

	const offer = await peer.createOffer();
	await peer.setLocalDescription(offer);

	const response = await fetch(REALTIME_CALLS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${clientSecret.value}`,
			"Content-Type": "application/sdp",
		},
		body: offer.sdp ?? "",
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		stopMedia(stream, peer, audio);
		throw new Error(
			`OpenAI Realtime WebRTC setup failed with HTTP ${response.status}: ${body}`,
		);
	}

	const answer = await response.text();
	await peer.setRemoteDescription({ type: "answer", sdp: answer });

	let stopped = false;
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			listeners.clear();
			stopMedia(stream, peer, audio);
		},
		onEvent: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		localStream: stream,
		remoteStream,
	};
}

async function getMicrophoneStream(): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (error) {
		if (isMicrophonePermissionError(error)) {
			throw new Error(
				"Microphone access is blocked by macOS. Open Settings → Experimental → Microphone Access, enable Helmor in Privacy & Security → Microphone, then restart Helmor if macOS asks you to.",
			);
		}
		throw error;
	}
}

function isMicrophonePermissionError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "NotAllowedError" || error.name === "SecurityError")
	);
}

function stopMedia(
	stream: MediaStream,
	peer: RTCPeerConnection,
	audio: HTMLAudioElement,
) {
	for (const sender of peer.getSenders()) {
		sender.track?.stop();
	}
	for (const track of stream.getTracks()) {
		track.stop();
	}
	audio.pause();
	audio.srcObject = null;
	peer.close();
}
