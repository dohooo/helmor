import { createOpenAiRealtimeClientSecret } from "@/lib/api";

export type RealtimeVoiceSession = {
	stop: () => void;
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

	peer.ontrack = (event) => {
		const [remoteStream] = event.streams;
		if (remoteStream) {
			audio.srcObject = remoteStream;
		}
	};

	for (const track of stream.getTracks()) {
		peer.addTrack(track, stream);
	}

	dataChannel.addEventListener("message", (event) => {
		try {
			const payload = JSON.parse(String(event.data)) as { type?: string };
			if (payload.type === "error") {
				console.error("[helmor] OpenAI Realtime error", payload);
			}
		} catch {
			// Ignore non-JSON control messages.
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

	return {
		stop: () => stopMedia(stream, peer, audio),
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
