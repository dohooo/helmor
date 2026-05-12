import { createOpenAiRealtimeClientSecret } from "@/lib/api";

/** Minimal shape of a server-pushed Realtime event. We only narrow the
 *  `type` discriminator -- everything else stays `unknown` so the consumer
 *  can pattern-match without us copying the full event schema. */
export type RealtimeServerEvent = {
	type?: string;
	[key: string]: unknown;
};

type EventListener = (event: RealtimeServerEvent) => void;

/** Client-side event posted back over the WebRTC data channel. Shape is
 *  open-ended for the same reason as RealtimeServerEvent — every caller
 *  pattern-matches against `type` and we don't want to copy the full
 *  event schema. */
export type RealtimeClientEvent = {
	type: string;
	[key: string]: unknown;
};

export type RealtimeVoiceSession = {
	/** Tear down peer + mic + speaker + close audio context. Idempotent. */
	stop: () => void;
	/** Subscribe to dataChannel events. Returns an unsubscribe. Listeners
	 *  registered before the WebRTC handshake completes still get every
	 *  event (including `session.created`) because the listener fan-out
	 *  is wired before `setLocalDescription`. */
	onEvent: (listener: EventListener) => () => void;
	/** Post a client event back to the model over the data channel.
	 *  Used by the tool dispatcher to return `function_call_output`
	 *  items and trigger follow-up responses. No-op (with a console
	 *  warning) if the data channel isn't open yet. */
	send: (event: RealtimeClientEvent) => void;
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

	// Token mint (Rust → OpenAI HTTPS) and getUserMedia (macOS TCC
	// prompt + first-frame negotiation) are independent and were the
	// two biggest "Connecting" stalls. Running them in parallel cuts
	// the perceived warmup by roughly one network round-trip.
	// `allSettled` so we can stop a hot mic stream if token mint races
	// to reject after mic succeeded — otherwise the yellow mic
	// indicator would linger on a failed session.
	const [tokenResult, micResult] = await Promise.allSettled([
		createOpenAiRealtimeClientSecret(),
		getMicrophoneStream(),
	]);
	if (tokenResult.status === "rejected") {
		if (micResult.status === "fulfilled") {
			for (const track of micResult.value.getTracks()) track.stop();
		}
		throw tokenResult.reason;
	}
	if (micResult.status === "rejected") {
		throw micResult.reason;
	}
	const clientSecret = tokenResult.value;
	const stream = micResult.value;
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
		send: (event) => {
			if (stopped) return;
			if (dataChannel.readyState !== "open") {
				console.warn(
					"[helmor] dropping Realtime client event sent before channel open",
					event.type,
				);
				return;
			}
			dataChannel.send(JSON.stringify(event));
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
