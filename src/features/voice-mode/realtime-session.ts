import { createOpenAiRealtimeClientSecret } from "@/lib/api";
import { voiceDiag } from "./voice-diag";

/** Tag session-lifecycle events under the `session.` namespace. */
function diag(event: string, data?: Record<string, unknown>) {
	voiceDiag(`session.${event}`, data);
}

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
	const sessionStart = performance.now();
	diag("start");

	if (!navigator.mediaDevices?.getUserMedia) {
		diag("abort", { reason: "getUserMedia unavailable" });
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
	diag("warmup-parallel-start", { tokenMint: true, micRequest: true });
	const tokenStart = performance.now();
	const micStart = performance.now();
	const [tokenResult, micResult] = await Promise.allSettled([
		createOpenAiRealtimeClientSecret().then(
			(v) => {
				diag("token-mint-ok", {
					elapsedMs: Math.round(performance.now() - tokenStart),
					expiresAt: v.expiresAt ?? null,
				});
				return v;
			},
			(err) => {
				diag("token-mint-failed", {
					elapsedMs: Math.round(performance.now() - tokenStart),
					error: messageOf(err),
				});
				throw err;
			},
		),
		getMicrophoneStream().then(
			(v) => {
				diag("mic-ok", {
					elapsedMs: Math.round(performance.now() - micStart),
					trackCount: v.getTracks().length,
				});
				return v;
			},
			(err) => {
				diag("mic-failed", {
					elapsedMs: Math.round(performance.now() - micStart),
					error: messageOf(err),
				});
				throw err;
			},
		),
	]);
	if (tokenResult.status === "rejected") {
		if (micResult.status === "fulfilled") {
			for (const track of micResult.value.getTracks()) track.stop();
			diag("cleanup-orphan-mic", { reason: "token mint failed after mic ok" });
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
	diag("peer-created");

	// Peer-state watchers: the WebRTC handshake silently transitions
	// through ICE / DTLS / connection states. When something hangs
	// ("Connecting" lingers forever), the operator wants to know
	// whether ICE never gathered candidates, the connection failed
	// post-DTLS, or the dataChannel never opened.
	peer.addEventListener("iceconnectionstatechange", () => {
		diag("peer-ice-state", { state: peer.iceConnectionState });
	});
	peer.addEventListener("connectionstatechange", () => {
		diag("peer-connection-state", { state: peer.connectionState });
	});
	peer.addEventListener("icegatheringstatechange", () => {
		diag("peer-ice-gathering", { state: peer.iceGatheringState });
	});
	peer.addEventListener("signalingstatechange", () => {
		diag("peer-signaling-state", { state: peer.signalingState });
	});

	dataChannel.addEventListener("open", () => {
		diag("datachannel-open", {
			elapsedMs: Math.round(performance.now() - sessionStart),
		});
	});
	dataChannel.addEventListener("close", () => {
		diag("datachannel-close");
	});
	dataChannel.addEventListener("error", (event) => {
		// `event` is an RTCErrorEvent in spec-compliant impls but Chromium
		// hands back a plain Event; walk both shapes.
		const err = (event as { error?: { message?: string } }).error;
		diag("datachannel-error", {
			message: err?.message ?? String(event.type ?? "unknown"),
		});
	});

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
			diag("remote-track", {
				elapsedMs: Math.round(performance.now() - sessionStart),
				trackCount: remote.getTracks().length,
			});
		}
	};

	for (const track of stream.getTracks()) {
		peer.addTrack(track, stream);
	}
	diag("local-tracks-added", { count: stream.getTracks().length });

	const listeners = new Set<EventListener>();
	let messageCount = 0;
	dataChannel.addEventListener("message", (event) => {
		messageCount++;
		let payload: RealtimeServerEvent;
		try {
			payload = JSON.parse(String(event.data)) as RealtimeServerEvent;
		} catch {
			// Non-JSON control messages -- ignore.
			diag("datachannel-non-json", { messageIndex: messageCount });
			return;
		}
		if (payload.type === "error") {
			console.error("[helmor] OpenAI Realtime error", payload);
			// Echo to the JSONL log too — `error` events from the server
			// are the single highest-signal diagnostic and tend to vanish
			// into the console history when the operator only has the
			// log file. The dispatcher echoes its own `server-error` for
			// dispatcher-context errors; this one is the raw stream.
			diag("server-stream-error", { event: payload });
		}
		for (const listener of listeners) {
			listener(payload);
		}
	});

	diag("create-offer");
	const offer = await peer.createOffer();
	await peer.setLocalDescription(offer);
	diag("local-description-set", {
		sdpBytes: offer.sdp?.length ?? 0,
	});

	const sdpExchangeStart = performance.now();
	diag("sdp-exchange-post", { url: REALTIME_CALLS_URL });
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
		diag("sdp-exchange-failed", {
			status: response.status,
			elapsedMs: Math.round(performance.now() - sdpExchangeStart),
			bodyPreview: body.slice(0, 500),
		});
		stopMedia(stream, peer, audio);
		throw new Error(
			`OpenAI Realtime WebRTC setup failed with HTTP ${response.status}: ${body}`,
		);
	}

	const answer = await response.text();
	diag("sdp-exchange-ok", {
		status: response.status,
		elapsedMs: Math.round(performance.now() - sdpExchangeStart),
		answerBytes: answer.length,
	});
	await peer.setRemoteDescription({ type: "answer", sdp: answer });
	diag("remote-description-set", {
		totalElapsedMs: Math.round(performance.now() - sessionStart),
	});

	let stopped = false;
	let sentCount = 0;
	let droppedCount = 0;
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			listeners.clear();
			stopMedia(stream, peer, audio);
			diag("stop", {
				sessionLifetimeMs: Math.round(performance.now() - sessionStart),
				clientEventsSent: sentCount,
				clientEventsDropped: droppedCount,
				serverMessagesReceived: messageCount,
			});
		},
		onEvent: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		send: (event) => {
			if (stopped) {
				droppedCount++;
				diag("client-event-dropped", {
					type: event.type,
					reason: "session stopped",
				});
				return;
			}
			if (dataChannel.readyState !== "open") {
				droppedCount++;
				console.warn(
					"[helmor] dropping Realtime client event sent before channel open",
					event.type,
				);
				diag("client-event-dropped", {
					type: event.type,
					reason: "datachannel not open",
					readyState: dataChannel.readyState,
				});
				return;
			}
			sentCount++;
			// Don't echo the full payload — conversation.item.create with
			// an embedded data URL is hundreds of KB. Echo type + key
			// size signals only. The dispatcher itself logs richer detail
			// per event type.
			const payload = JSON.stringify(event);
			dataChannel.send(payload);
		},
		localStream: stream,
		remoteStream,
	};
}

/** Best-effort string from a thrown value. WebRTC / fetch errors
 *  arrive as a mix of `Error`, `DOMException`, and plain strings; we
 *  want a single-line message for the JSONL field. */
function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
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
